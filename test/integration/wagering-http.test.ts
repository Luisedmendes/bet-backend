import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import { ProcessPendingReferencesUseCase } from '../../src/application/use-cases/process-pending-references.use-case.js';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { TOKENS } from '../../src/interface/http/tokens.js';
import {
  createTestQueues,
  ensureTestDatabase,
  expectLedgerConsistent,
  sql,
  startApp,
  testEnv,
  uuid,
  wager,
} from '../support/harness.js';

describe('wagering over HTTP (real PostgreSQL)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const wallets: string[] = [];

  beforeAll(async () => {
    await ensureTestDatabase();
    // Referências: 3 tentativas sem espera, para o teste de expiração ser rápido.
    const env = testEnv({ suffix: 'http', REFERENCE_MAX_ATTEMPTS: '3', REFERENCE_BASE_DELAY_MS: '0' });
    await createTestQueues(env);
    app = await startApp(env);
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await expectLedgerConsistent(wallets);
    await app.close();
  });

  async function openWallet(amount = '100.00') {
    const res = await http
      .post('/wallets')
      .send({ playerId: uuid(), initialBalance: { amount, currency: 'BRL' } })
      .expect(201);
    wallets.push(res.body.id);
    return res.body as { id: string; playerId: string; balance: { amount: string }; version: number };
  }

  const submit = (body: Record<string, unknown>, key = `provider-a:${String(body.externalTransactionId)}`) =>
    http.post('/wagering/transactions').set('Idempotency-Key', key).send(body);

  describe('wallets', () => {
    it('creates a wallet with version 1 and an OPENING ledger entry', async () => {
      const wallet = await openWallet('1000.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.amount).toBe('1000.00');

      const ledger = await http.get(`/wallets/${wallet.id}/ledger`).expect(200);
      expect(ledger.body.entries).toHaveLength(1);
      expect(ledger.body.entries[0].direction).toBe('CREDIT');
    });

    it('creates a zero-balance wallet without ledger entries', async () => {
      const wallet = await openWallet('0.00');
      const ledger = await http.get(`/wallets/${wallet.id}/ledger`).expect(200);
      expect(ledger.body.entries).toHaveLength(0);
    });

    it('rejects a duplicate wallet for the same player and currency with 409', async () => {
      const wallet = await openWallet();
      const res = await http
        .post('/wallets')
        .send({ playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } })
        .expect(409);
      expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    });

    it('allows the same player in another currency', async () => {
      const wallet = await openWallet();
      const res = await http
        .post('/wallets')
        .send({ playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'USD' } })
        .expect(201);
      wallets.push(res.body.id);
    });

    it('validates the payload with 400', async () => {
      const res = await http
        .post('/wallets')
        .send({ playerId: 'nope', initialBalance: { amount: '1.5', currency: 'BRL' } })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toHaveLength(2);
    });

    it('returns 404 for an unknown wallet', async () => {
      await http.get(`/wallets/${uuid()}`).expect(404);
    });

    it('paginates the ledger with a stable opaque cursor', async () => {
      const wallet = await openWallet('100.00');
      for (let i = 0; i < 4; i++) await submit(wager(wallet, `page-${wallet.id}-${i}`, 'BET', '1.00')).expect(201);

      const first = await http.get(`/wallets/${wallet.id}/ledger?limit=2`).expect(200);
      const second = await http.get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`).expect(200);
      const third = await http.get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${second.body.nextCursor}`).expect(200);

      const ids = [...first.body.entries, ...second.body.entries, ...third.body.entries].map((e: { id: string }) => e.id);
      expect(new Set(ids).size).toBe(5);
      const balances = [...first.body.entries, ...second.body.entries, ...third.body.entries].map(
        (e: { balanceAfter: { amount: string } }) => e.balanceAfter.amount,
      );
      expect(balances).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00']);
      expect(third.body.nextCursor).toBeNull();
      await http.get(`/wallets/${wallet.id}/ledger?cursor=garbage`).expect(400);
    });
  });

  describe('POST /wagering/transactions', () => {
    it('processes a BET (201) and replays it with the original response (200)', async () => {
      const wallet = await openWallet('1000.00');
      const body = wager(wallet, `bet-${uuid()}`, 'BET', '25.00');

      const first = await submit(body).expect(201);
      expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00' }, idempotentReplay: false });

      // O saldo muda depois; o replay devolve o saldo observado na época.
      await submit(wager(wallet, `win-${uuid()}`, 'WIN', '100.00')).expect(201);

      const replay = await submit(body).expect(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('treats the same key with a different payload as a conflict (409), not a replay', async () => {
      const wallet = await openWallet();
      const body = wager(wallet, `bet-${uuid()}`, 'BET', '10.00');
      await submit(body).expect(201);

      const res = await submit({ ...body, money: { amount: '11.00', currency: 'BRL' } }).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('treats the same external id under another key as a conflict (409)', async () => {
      const wallet = await openWallet();
      const body = wager(wallet, `bet-${uuid()}`, 'BET', '10.00');
      await submit(body).expect(201);
      const res = await submit(body, `other-key-${uuid()}`).expect(409);
      expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    });

    it('rejects a BET without funds with 422 and INSUFFICIENT_FUNDS', async () => {
      const wallet = await openWallet('10.00');
      const res = await submit(wager(wallet, `bet-${uuid()}`, 'BET', '80.00')).expect(422);
      expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
      expect(res.body.balance.amount).toBe('10.00');
    });

    it('rejects a currency different from the wallet', async () => {
      const wallet = await openWallet();
      const res = await submit({ ...wager(wallet, `bet-${uuid()}`, 'BET', '1.00'), money: { amount: '1.00', currency: 'USD' } }).expect(422);
      expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
    });

    it('processes LOSS without touching the balance or the ledger', async () => {
      const wallet = await openWallet('50.00');
      const res = await submit(wager(wallet, `loss-${uuid()}`, 'LOSS', '0.00')).expect(201);
      expect(res.body.balance.amount).toBe('50.00');
      const view = await http.get(`/wallets/${wallet.id}`).expect(200);
      expect(view.body.version).toBe(1);
    });

    it('REFUND reverts a BET once', async () => {
      const wallet = await openWallet('100.00');
      const betId = `bet-${uuid()}`;
      await submit(wager(wallet, betId, 'BET', '30.00')).expect(201);

      const refund = await submit(wager(wallet, `refund-${uuid()}`, 'REFUND', '30.00', { referenceExternalTransactionId: betId })).expect(201);
      expect(refund.body.balance.amount).toBe('100.00');

      const again = await submit(wager(wallet, `refund-${uuid()}`, 'REFUND', '30.00', { referenceExternalTransactionId: betId })).expect(422);
      expect(again.body.failureCode).toBe('ALREADY_REVERSED');
    });

    it('ROLLBACK of a WIN debits it back; without funds it is REVERSAL_INSUFFICIENT_FUNDS', async () => {
      const wallet = await openWallet('10.00');
      const winId = `win-${uuid()}`;
      await submit(wager(wallet, winId, 'WIN', '50.00')).expect(201);
      await submit(wager(wallet, `bet-${uuid()}`, 'BET', '55.00')).expect(201); // sobra 5.00

      const rollback = await submit(wager(wallet, `rb-${uuid()}`, 'ROLLBACK', '50.00', { referenceExternalTransactionId: winId })).expect(422);
      expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    });

    it('rejects a REFUND whose amount differs from the BET', async () => {
      const wallet = await openWallet();
      const betId = `bet-${uuid()}`;
      await submit(wager(wallet, betId, 'BET', '30.00')).expect(201);
      const res = await submit(wager(wallet, `refund-${uuid()}`, 'REFUND', '10.00', { referenceExternalTransactionId: betId })).expect(422);
      expect(res.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    });

    it('requires the Idempotency-Key header and a valid payload (400)', async () => {
      const wallet = await openWallet();
      await http.post('/wagering/transactions').send(wager(wallet, 'x', 'BET', '1.00')).expect(400);
      await submit(wager(wallet, `x-${uuid()}`, 'OPENING', '1.00')).expect(400);
      await submit(wager(wallet, `x-${uuid()}`, 'REFUND', '1.00')).expect(400);
      await submit(wager(wallet, `x-${uuid()}`, 'BET', '1e3')).expect(400);
      await submit(wager(wallet, `x-${uuid()}`, 'BET', '-1.00')).expect(400);
      const malformed = await http
        .post('/wagering/transactions')
        .set('Idempotency-Key', 'k')
        .set('Content-Type', 'application/json')
        .send('{not json');
      expect(malformed.status).toBe(400);
    });

    it('returns 404 for an unknown wallet', async () => {
      const res = await submit(wager({ id: uuid(), playerId: uuid() }, `x-${uuid()}`, 'BET', '1.00')).expect(404);
      expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    });

    it('exposes transactions by internal id and by provider id', async () => {
      const wallet = await openWallet();
      const externalId = `bet-${uuid()}`;
      const created = await submit(wager(wallet, externalId, 'BET', '5.00')).expect(201);

      const byId = await http.get(`/wagering/transactions/${created.body.transactionId}`).expect(200);
      const byExternal = await http.get(`/providers/provider-a/wagering/transactions/${externalId}`).expect(200);
      expect(byId.body).toEqual(byExternal.body);
      expect(byId.body.kind).toBe('BET');
    });
  });

  describe('out of order references (README §7.1)', () => {
    it('ROLLBACK before its BET waits as PENDING_REFERENCE (202) and is applied once the BET arrives', async () => {
      const wallet = await openWallet('100.00');
      const betId = `bet-${uuid()}`;

      const early = await submit(wager(wallet, `rb-${uuid()}`, 'ROLLBACK', '40.00', { referenceExternalTransactionId: betId })).expect(202);
      expect(early.body.status).toBe('PENDING_REFERENCE');

      await submit(wager(wallet, betId, 'BET', '40.00')).expect(201);
      await app.get(ProcessPendingReferencesUseCase).runOnce();

      const rollback = await http.get(`/wagering/transactions/${early.body.transactionId}`).expect(200);
      expect(rollback.body.status).toBe('PROCESSED');
      const view = await http.get(`/wallets/${wallet.id}`).expect(200);
      expect(view.body.balance.amount).toBe('100.00');
    });

    it('expires as REJECTED REFERENCE_NOT_FOUND after the attempt limit, with an event', async () => {
      const wallet = await openWallet();
      const early = await submit(wager(wallet, `rb-${uuid()}`, 'ROLLBACK', '1.00', { referenceExternalTransactionId: `never-${uuid()}` })).expect(202);

      const worker = app.get(ProcessPendingReferencesUseCase);
      for (let i = 0; i < 3; i++) await worker.runOnce();

      const tx = await http.get(`/wagering/transactions/${early.body.transactionId}`).expect(200);
      expect(tx.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });

      const db = await sql();
      const events = await db.query(
        `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY occurred_at`,
        [early.body.transactionId],
      );
      await db.end();
      expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    });
  });

  describe('atomicity and events', () => {
    it('writes transaction, ledger, balance and outbox together', async () => {
      const wallet = await openWallet('100.00');
      const res = await submit(wager(wallet, `bet-${uuid()}`, 'BET', '10.00')).expect(201);

      const db = await sql();
      const events = await db.query(
        `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 AND (payload->'data'->>'transactionId') = $2 ORDER BY event_type`,
        [wallet.id, res.body.transactionId],
      );
      const entries = await db.query('SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id = $1', [res.body.transactionId]);
      await db.end();
      expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      expect(entries.rows[0].n).toBe(1);
    });

    it('rolls everything back when the unit of work fails midway', async () => {
      const uow = app.get<UnitOfWork>(TOKENS.unitOfWork);
      const walletId = uuid();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: uuid(),
        initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
        openingTransactionId: uuid(),
        at: new Date(),
      });

      const failure = await uow
        .run(async (repos) => {
          repos.wallets.insert(wallet);
          repos.ledger.append(openingEntry!);
          throw new Error('crash before commit');
        })
        .catch((error: Error) => error);
      expect((failure as Error).message).toBe('crash before commit');

      await http.get(`/wallets/${walletId}`).expect(404);
    });

    it('reconciles stored balance against the ledger', async () => {
      const wallet = await openWallet('100.00');
      await submit(wager(wallet, `bet-${uuid()}`, 'BET', '33.33')).expect(201);
      const res = await http.post(`/wallets/${wallet.id}/reconciliation`).expect(200);
      expect(res.body).toMatchObject({
        storedBalance: { amount: '66.67' },
        calculatedBalance: { amount: '66.67' },
        difference: { amount: '0.00' },
        consistent: true,
        checkedEntries: 2,
      });
    });
  });

  describe('health and metrics', () => {
    it('reports liveness and readiness without auth', async () => {
      await http.get('/health/live').expect(200);
      const ready = await http.get('/health/ready').expect(200);
      expect(ready.body.checks).toEqual({ database: 'ok', sqs: 'ok' });
    });

    it('exposes prometheus metrics', async () => {
      const res = await http.get('/metrics').expect(200);
      expect(res.text).toContain('wagering_transactions_total');
      expect(res.text).toContain('wagering_duplicates_total');
    });
  });
});
