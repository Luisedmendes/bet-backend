import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Subprocess } from 'bun';
import type { INestApplication } from '@nestjs/common';
import type { AppEnv } from '../../src/infrastructure/config/env.js';
import {
  createTestQueues,
  ensureTestDatabase,
  expectLedgerConsistent,
  sendWagerMessage,
  sql,
  startApp,
  TEST_DB,
  testEnv,
  uuid,
  wager,
  waitFor,
} from '../support/harness.js';

/**
 * Paralelismo REAL: requisições HTTP simultâneas contra um servidor de verdade
 * e, nos cenários multi-instância, processos `bun` separados disputando o
 * mesmo PostgreSQL e a mesma fila SQS.
 */
describe('concurrency', () => {
  let app: INestApplication;
  let baseUrl: string;
  const wallets: string[] = [];

  beforeAll(async () => {
    await ensureTestDatabase();
    const env = testEnv({ suffix: 'concurrency' });
    await createTestQueues(env);
    app = await startApp(env);
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await expectLedgerConsistent(wallets);
    await app.close();
  });

  async function openWallet(amount: string, url = baseUrl) {
    const res = await fetch(`${url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: uuid(), initialBalance: { amount, currency: 'BRL' } }),
    });
    expect(res.status).toBe(201);
    const wallet = (await res.json()) as { id: string; playerId: string };
    wallets.push(wallet.id);
    return wallet;
  }

  async function post(body: Record<string, unknown>, url = baseUrl, key = `provider-a:${String(body.externalTransactionId)}`) {
    const res = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async function ledgerCount(walletId: string, direction: 'DEBIT' | 'CREDIT'): Promise<number> {
    const db = await sql();
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = $2',
      [walletId, direction],
    );
    await db.end();
    return rows[0].n;
  }

  async function balance(walletId: string, url = baseUrl): Promise<string> {
    const res = await fetch(`${url}/wallets/${walletId}`);
    return ((await res.json()) as { balance: { amount: string } }).balance.amount;
  }

  it('1. the same BET sent 50 times in parallel debits once', async () => {
    const wallet = await openWallet('1000.00');
    const body = wager(wallet, `bet-${uuid()}`, 'BET', '10.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => post(body)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(results.every((r) => r.body.balance.amount === '990.00')).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await balance(wallet.id)).toBe('990.00');
  });

  it('2. two BETs of 80.00 against 100.00: exactly one PROCESSED, one INSUFFICIENT_FUNDS, final 20.00', async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await openWallet('100.00');
      const bodyA = wager(wallet, `bet-a-${uuid()}`, 'BET', '80.00');
      const bodyB = wager(wallet, `bet-b-${uuid()}`, 'BET', '80.00');
      const [a, b] = await Promise.all([post(bodyA), post(bodyB)]);

      expect([a.body.status, b.body.status].sort((x, y) => String(x).localeCompare(String(y)))).toEqual(['PROCESSED', 'REJECTED']);
      expect([a, b].find((r) => r.body.status === 'REJECTED')!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balance(wallet.id)).toBe('20.00');
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);

      // Retries (das duas) devolvem o resultado original e não duplicam o débito.
      const retries = await Promise.all([post(bodyA), post(bodyB), post(bodyA), post(bodyB)]);
      expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    }
  });

  it('hot wallet: 40 different BETs of 5.00 against 100.00 → exactly 20 processed, balance 0.00', async () => {
    const wallet = await openWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post(wager(wallet, `hot-${i}-${uuid()}`, 'BET', '5.00'))),
    );
    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(20);
    expect(results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(20);
    expect(await balance(wallet.id)).toBe('0.00');
  });

  it('3. different wallets are processed in parallel without interfering', async () => {
    const group = await Promise.all(Array.from({ length: 10 }, () => openWallet('100.00')));
    const started = performance.now();
    await Promise.all(
      group.flatMap((wallet) => Array.from({ length: 10 }, (_, i) => post(wager(wallet, `w-${i}-${uuid()}`, 'BET', '1.00')))),
    );
    const elapsed = performance.now() - started;

    for (const wallet of group) expect(await balance(wallet.id)).toBe('90.00');
    expect(elapsed).toBeLessThan(15_000);
  });

  describe('multiple processes', () => {
    let env: AppEnv;
    let queues: { wager: string };
    const processes: Subprocess[] = [];

    beforeAll(async () => {
      env = testEnv({ suffix: 'multi', SQS_VISIBILITY_TIMEOUT_SECONDS: '3' });
      queues = await createTestQueues(env, 5);
    });

    afterAll(() => {
      for (const p of processes) p.kill(9);
    });

    async function spawnInstance(port: number, workers = true): Promise<Subprocess> {
      const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
        env: {
          ...process.env,
          PORT: String(port),
          INSTANCE_ID: `test-${port}`,
          POSTGRES_DB: TEST_DB,
          SQS_WAGER_QUEUE_NAME: env.sqs.wagerQueueName,
          SQS_WAGER_DLQ_NAME: env.sqs.wagerDlqName,
          SQS_EVENTS_QUEUE_NAME: env.sqs.eventsQueueName,
          SQS_WAIT_TIME_SECONDS: '1',
          SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
          WORKER_SQS_CONSUMER: String(workers),
          WORKER_OUTBOX_PUBLISHER: String(workers),
          WORKER_PENDING_REFERENCES: String(workers),
          OUTBOX_INTERVAL_MS: '100',
          PENDING_REFERENCES_INTERVAL_MS: '200',
          REFERENCE_BASE_DELAY_MS: '100',
          SHUTDOWN_DRAIN_MS: '2000',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      processes.push(proc);
      await waitFor(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok;
          } catch {
            return false;
          }
        },
        { timeoutMs: 30_000 },
      );
      return proc;
    }

    it('4. three instances share hot wallets over HTTP and SQS without breaking invariants', async () => {
      const ports = [3911, 3912, 3913];
      await Promise.all(ports.map((port) => spawnInstance(port)));
      const urls = ports.map((p) => `http://127.0.0.1:${p}`);

      const hot = await Promise.all(Array.from({ length: 3 }, () => openWallet('100.00', urls[0])));

      // HTTP: cada pedido vai 3 vezes, uma para cada instância (duplicatas entre instâncias).
      const http = hot.flatMap((wallet) =>
        Array.from({ length: 15 }, (_, i) => wager(wallet, `multi-http-${i}-${uuid()}`, 'BET', '5.00')),
      );
      // SQS: mesmas wallets, consumidas pelas 3 instâncias; cada mensagem enviada 2 vezes.
      const viaQueue = hot.flatMap((wallet) =>
        Array.from({ length: 10 }, (_, i) => wager(wallet, `multi-sqs-${i}-${uuid()}`, 'BET', '5.00')),
      );
      await Promise.all([
        ...http.flatMap((body) => urls.map((url) => post(body, url))),
        ...viaQueue.flatMap((body) => {
          const messageId = `m-${body.externalTransactionId}`;
          const data = { ...body, idempotencyKey: `provider-a:${body.externalTransactionId}` };
          return [sendWagerMessage(queues.wager, messageId, data), sendWagerMessage(queues.wager, messageId, data)];
        }),
      ]);

      // Espera a fila ser consumida: toda transação SQS gravada.
      const db = await sql();
      await waitFor(
        async () => {
          const { rows } = await db.query(
            `SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id LIKE 'multi-sqs-%' AND wallet_id = ANY($1::uuid[])`,
            [hot.map((w) => w.id)],
          );
          return rows[0].n === viaQueue.length;
        },
        { timeoutMs: 60_000 },
      );

      // 25 BETs de 5.00 por wallet de 100.00: exatamente 20 processadas, saldo 0.00.
      for (const wallet of hot) {
        const { rows } = await db.query(
          `SELECT status, count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET' GROUP BY status`,
          [wallet.id],
        );
        const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
        expect(byStatus).toEqual({ PROCESSED: 20, REJECTED: 5 });
        expect(await balance(wallet.id, urls[1])).toBe('0.00');
      }
      await db.end();
      await expectLedgerConsistent(hot.map((w) => w.id));
    }, 120_000);

    it('8. kill -9 mid-traffic and restart: final state is consistent and no event is lost', async () => {
      for (const p of processes.splice(0)) p.kill(9);

      const victim = await spawnInstance(3921);
      const wallet = await openWallet('500.00', 'http://127.0.0.1:3921');
      const bodies = Array.from({ length: 40 }, (_, i) => wager(wallet, `restart-${i}-${uuid()}`, 'BET', '1.00'));
      await Promise.all(
        bodies.map((body) =>
          sendWagerMessage(queues.wager, `m-${body.externalTransactionId}`, {
            ...body,
            idempotencyKey: `provider-a:${body.externalTransactionId}`,
          }),
        ),
      );

      // Mata no meio do consumo, sem chance de shutdown gracioso.
      const db = await sql();
      await waitFor(async () => {
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`, [wallet.id]);
        return rows[0].n >= 5;
      });
      victim.kill(9);
      await victim.exited;

      // Reinício: duas instâncias novas assumem a fila e a outbox.
      await Promise.all([spawnInstance(3922), spawnInstance(3923)]);
      await waitFor(
        async () => {
          const { rows } = await db.query(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`, [wallet.id]);
          return rows[0].n === bodies.length;
        },
        { timeoutMs: 60_000 },
      );
      await waitFor(
        async () => {
          const { rows } = await db.query(
            `SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`,
            [wallet.id],
          );
          return rows[0].n === 0;
        },
        { timeoutMs: 30_000 },
      );

      expect(await balance(wallet.id, 'http://127.0.0.1:3922')).toBe('460.00');
      const { rows: debits } = await db.query(
        `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
        [wallet.id],
      );
      expect(debits[0].n).toBe(40);
      // 1 evento de abertura (2 linhas) + 2 por BET, todos publicados.
      const { rows: events } = await db.query(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1`, [wallet.id]);
      expect(events[0].n).toBe(2 + 40 * 2);
      await db.end();
      await expectLedgerConsistent([wallet.id]);
    }, 180_000);
  });
});
