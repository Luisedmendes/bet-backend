import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories.js';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { InboxMessage } from '../../domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { Money } from '../../domain/money/money.js';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import { InboxMessageEntity, OutboxMessageEntity } from './entities/messaging.entity.js';
import { WagerTransactionEntity } from './entities/wager-transaction.entity.js';
import { WalletEntity } from './entities/wallet.entity.js';
import {
  inboxToDomain,
  type LedgerRow,
  ledgerRowToDomain,
  ledgerToRow,
  outboxToDomain,
  outboxToRow,
  transactionToDomain,
  transactionToRow,
  walletToDomain,
  walletToRow,
} from './mappers.js';

/**
 * Repositórios presos a um EntityManager transacional. Escritas viram
 * mudanças na Unit of Work e só vão ao banco no flush do COMMIT; leituras
 * passam pelo Identity Map. `update()` exige que o agregado tenha sido
 * carregado nesta mesma unidade de trabalho.
 */
export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

class ManagedRows<T> {
  private readonly rows = new Map<string, T>();

  track(id: string, row: T): T {
    this.rows.set(id, row);
    return row;
  }

  get(id: string, what: string): T {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`${what} ${id} must be loaded in this unit of work before update`);
    }
    return row;
  }
}

class MikroOrmWalletRepository implements WalletRepository {
  private readonly managed = new ManagedRows<WalletEntity>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    return this.load(id, LockMode.NONE);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.load(id, LockMode.PESSIMISTIC_WRITE);
  }

  async findByIdForShare(id: string): Promise<Wallet | null> {
    return this.load(id, LockMode.PESSIMISTIC_READ);
  }

  insert(wallet: Wallet): void {
    this.em.persist(this.managed.track(wallet.id, walletToRow(wallet)));
  }

  update(wallet: Wallet): void {
    walletToRow(wallet, this.managed.get(wallet.id, 'Wallet'));
  }

  private async load(id: string, lockMode: LockMode): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletEntity,
      { id },
      lockMode === LockMode.NONE ? {} : { lockMode },
    );
    return row ? walletToDomain(this.managed.track(id, row)) : null;
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly managed = new ManagedRows<WagerTransactionEntity>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.map(await this.em.findOne(WagerTransactionEntity, { id }));
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    return this.map(await this.em.findOne(WagerTransactionEntity, { idempotencyKey: key }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.map(await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId }));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const rows = await this.em.find(
      WagerTransactionEntity,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc' }, limit },
    );
    return rows.map((row) => ({ id: row.id, walletId: row.walletId }));
  }

  async expediteDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        nextReferenceAttemptAt: { $gt: now },
      },
      { nextReferenceAttemptAt: now },
    );
  }

  insert(tx: WagerTransaction): void {
    this.em.persist(this.managed.track(tx.id, transactionToRow(tx)));
  }

  update(tx: WagerTransaction): void {
    transactionToRow(tx, this.managed.get(tx.id, 'WagerTransaction'));
  }

  private map(row: WagerTransactionEntity | null): WagerTransaction | null {
    return row ? transactionToDomain(this.managed.track(row.id, row)) : null;
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
    this.em.persist(ledgerToRow(entry));
  }

  async page(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPage> {
    // Cursor estável: seq é monotônico e nunca reutilizado (ledger append-only).
    const rows = await this.em.execute<(LedgerRow & { seq: string })[]>(
      `SELECT seq::text AS seq, id, wallet_id, transaction_id, direction, amount::text AS amount,
              currency, balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND wallet_ledger_entries.seq > ?::bigint
        ORDER BY wallet_ledger_entries.seq
        LIMIT ?`,
      [walletId, afterSeq ?? '0', limit + 1],
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      entries: pageRows.map((row) => ({ seq: row.seq, entry: ledgerRowToDomain(row) })),
      nextCursor: hasMore ? pageRows[pageRows.length - 1]!.seq : undefined,
    };
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<{ credits: string; debits: string; count: number }[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(30, 2)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(30, 2)::text AS debits,
              COUNT(*)::int AS count
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return {
      credits: Money.from({ amount: row!.credits, currency }),
      debits: Money.from({ amount: row!.debits, currency }),
      count: Number(row!.count),
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    // processed_at no mesmo INSERT: a linha só existe se o efeito foi commitado junto.
    const rows = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const row = await this.em.findOne(InboxMessageEntity, { consumerName, messageId });
    return row ? inboxToDomain(row) : null;
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  private readonly managed = new ManagedRows<OutboxMessageEntity>();

  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(this.managed.track(message.id, outboxToRow(message)));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // FOR UPDATE SKIP LOCKED: publishers concorrentes nunca pegam a mesma linha.
    const rows = await this.em.find(
      OutboxMessageEntity,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { occurredAt: 'asc', id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return rows.map((row) => outboxToDomain(this.managed.track(row.id, row)));
  }

  update(message: OutboxMessage): void {
    outboxToRow(message, this.managed.get(message.id, 'OutboxMessage'));
  }

  async lag(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [row] = await this.em.execute<{ pending: number; oldest: Date | string | null }[]>(
      `SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest
         FROM outbox_messages
        WHERE published_at IS NULL`,
    );
    const oldest = row?.oldest ? new Date(row.oldest) : undefined;
    return {
      pending: Number(row?.pending ?? 0),
      oldestAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }
}
