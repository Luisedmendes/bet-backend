import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { createMikroOrmConfig } from '../../src/mikro-orm.config.js';
import { ensureTestDatabase, sql, TEST_DB, testEnv, uuid } from '../support/harness.js';

/**
 * Garantias aplicadas pelo PRÓPRIO BANCO (README §5, restrição 9): estes testes
 * escrevem SQL direto, sem passar pelo domínio, e esperam o Postgres recusar.
 */
describe('schema constraints', () => {
  let db: Client;

  beforeAll(async () => {
    await ensureTestDatabase();
    db = await sql();
  });
  afterAll(async () => {
    await db.end();
  });

  const hash = 'a'.repeat(64);
  const now = new Date().toISOString();

  /** Cria wallet + OPENING + lançamento coerentes numa transação. */
  async function walletWithBalance(balance = '100.00'): Promise<{ walletId: string; openingId: string }> {
    const walletId = uuid();
    const openingId = uuid();
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1, $2, 'BRL', $3, 1, $4, $4)`,
        [walletId, uuid(), balance, now],
      );
      await db.query(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, status, result_balance,
           created_at, updated_at, processed_at)
         VALUES ($1, 'internal', $2, $3, $4, $5, $6, 'opening', 'internal', 'OPENING', $7, 'BRL', 'PROCESSED', $7, $8, $8, $8)`,
        [openingId, `opening:${walletId}`, `internal:opening:${walletId}`, hash, walletId, uuid(), balance, now],
      );
      await db.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
           balance_before, balance_after, created_at)
         VALUES ($1, $2, $3, 'CREDIT', $4, 'BRL', 0, $4, $5)`,
        [uuid(), walletId, openingId, balance, now],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    return { walletId, openingId };
  }

  async function expectRejected(statement: string, params: unknown[], pattern?: RegExp): Promise<void> {
    await db.query('BEGIN');
    let error: Error | undefined;
    try {
      await db.query(statement, params);
      await db.query('COMMIT');
    } catch (e) {
      error = e as Error;
      await db.query('ROLLBACK');
    }
    expect(error).toBeDefined();
    if (pattern) expect(error!.message).toMatch(pattern);
  }

  it('migrations are reversible: up → down → up on a scratch database', async () => {
    const scratch = `${TEST_DB}_migrations`;
    await db.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await db.query(`CREATE DATABASE "${scratch}"`);
    const orm = await MikroORM.init(createMikroOrmConfig(testEnv({ POSTGRES_DB: scratch })));
    try {
      await orm.migrator.up();
      await orm.migrator.down({ to: 0 });
      const [{ count }] = await orm.em
        .fork()
        .getConnection()
        .execute<{ count: string }[]>(
          `SELECT count(*)::text AS count FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'`,
        );
      expect(count).toBe('0');
      await orm.migrator.up();
      expect(await orm.migrator.getPending()).toHaveLength(0);
    } finally {
      await orm.close(true);
      await db.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    }
  });

  it('accepts a coherent wallet + opening + ledger entry', async () => {
    const { walletId } = await walletWithBalance('100.00');
    const { rows } = await db.query('SELECT balance::text FROM wallets WHERE id = $1', [walletId]);
    expect(rows[0].balance).toBe('100.00');
  });

  it('rejects a negative wallet balance', async () => {
    const { walletId } = await walletWithBalance();
    await expectRejected('UPDATE wallets SET balance = -1, version = version + 1 WHERE id = $1', [walletId], /non_negative/);
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const playerId = uuid();
    await db.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1, $2, 'BRL', 0, 1, now(), now())`,
      [uuid(), playerId],
    );
    await expectRejected(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1, $2, 'BRL', 0, 1, now(), now())`,
      [uuid(), playerId],
      /wallets_player_currency_unique/,
    );
  });

  it('rejects a balance change without a matching ledger entry (checked at COMMIT)', async () => {
    const { walletId } = await walletWithBalance();
    await expectRejected(
      'UPDATE wallets SET balance = 50, version = version + 1 WHERE id = $1',
      [walletId],
      /does not match ledger/,
    );
  });

  it('rejects a version that does not follow the balance', async () => {
    const { walletId } = await walletWithBalance();
    await expectRejected('UPDATE wallets SET version = version + 1 WHERE id = $1', [walletId], /version/);
  });

  it('blocks UPDATE, DELETE and TRUNCATE on the ledger', async () => {
    const { walletId } = await walletWithBalance();
    await expectRejected('UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1', [walletId], /append-only/);
    await expectRejected('DELETE FROM wallet_ledger_entries WHERE wallet_id = $1', [walletId], /append-only/);
    await expectRejected('TRUNCATE wallet_ledger_entries CASCADE', [], /append-only/);
  });

  it('rejects an unbalanced ledger entry', async () => {
    const { walletId, openingId } = await walletWithBalance('100.00');
    await expectRejected(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 95, now())`,
      [uuid(), walletId, openingId],
      /wallet_ledger_entries_balanced/,
    );
  });

  it('rejects a ledger entry that breaks the chain', async () => {
    const { walletId, openingId } = await walletWithBalance('100.00');
    await expectRejected(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 50, 40, now())`,
      [uuid(), walletId, openingId],
      /chain broken/,
    );
  });

  it('rejects a second ledger entry for the same transaction', async () => {
    const { walletId, openingId } = await walletWithBalance('100.00');
    await expectRejected(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 90, now())`,
      [uuid(), walletId, openingId],
      /one_per_transaction/,
    );
  });

  it('keeps terminal transactions immutable and never deletes them', async () => {
    const { openingId } = await walletWithBalance();
    await expectRejected(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = $1`, [openingId], /terminal/);
    await expectRejected('DELETE FROM wager_transactions WHERE id = $1', [openingId], /cannot be deleted/);
  });

  it('enforces unique idempotency keys', async () => {
    const { walletId } = await walletWithBalance();
    await expectRejected(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, created_at, updated_at)
       VALUES ($1, 'internal', 'x', $2, $3, $4, $5, 'r', 'g', 'OPENING', 1, 'BRL', 'PENDING', now(), now())`,
      [uuid(), `internal:opening:${walletId}`, hash, walletId, uuid()],
      /idempotency_key_unique/,
    );
  });

  it('requires a reference for REFUND and ROLLBACK', async () => {
    const { walletId } = await walletWithBalance();
    await expectRejected(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, created_at, updated_at)
       VALUES ($1, 'p', $2, $2, $3, $4, $5, 'r', 'g', 'REFUND', 1, 'BRL', 'PENDING', now(), now())`,
      [uuid(), uuid(), hash, walletId, uuid()],
      /reference_required/,
    );
  });
});
