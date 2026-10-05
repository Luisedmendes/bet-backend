import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { InboxMessage } from '../../domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { Money } from '../../domain/money/money.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT … FOR UPDATE: serializa tudo que toca a mesma wallet. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** SELECT … FOR SHARE: leitura consistente sem bloquear outras leituras. */
  findByIdForShare(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): void;
  update(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Ids (e wallets) de PENDING_REFERENCE prontas para nova tentativa. */
  findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  /** Antecipa a próxima tentativa das transações que esperam por esta referência. */
  expediteDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  insert(tx: WagerTransaction): void;
  update(tx: WagerTransaction): void;
}

export interface LedgerPage {
  entries: { seq: string; entry: WalletLedgerEntry }[];
  nextCursor: string | undefined;
}

export interface LedgerTotals {
  credits: Money;
  debits: Money;
  count: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): void;
  page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface InboxRepository {
  /** INSERT … ON CONFLICT DO NOTHING. false = mensagem já registrada (duplicata). */
  tryInsert(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /** SELECT … FOR UPDATE SKIP LOCKED: cada publisher pega um lote diferente. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): void;
  /** Idade (segundos) da mensagem pendente mais antiga, e quantas estão pendentes. */
  lag(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Executa `work` dentro de UMA transação SQL. As escritas registradas nos
 * repositórios são confirmadas juntas no commit, ou descartadas juntas.
 */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
