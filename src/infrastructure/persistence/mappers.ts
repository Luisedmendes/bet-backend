import { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { Money } from '../../domain/money/money.js';
import type { FailureCode } from '../../domain/wagering/failure-code.js';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { LedgerEntryEntity } from './entities/ledger-entry.entity.js';
import { InboxMessageEntity, OutboxMessageEntity } from './entities/messaging.entity.js';
import { WagerTransactionEntity } from './entities/wager-transaction.entity.js';
import { WalletEntity } from './entities/wallet.entity.js';

/**
 * Converte entre linhas do banco e objetos de domínio (D2). A leitura sempre
 * passa pelo `rehydrate` do domínio; valores monetários trafegam como string
 * decimal exata (numeric(19,2)), nunca como number.
 */
const money = (amount: string, currency: string) => Money.from({ amount, currency });

// ------------------------------------------------------------------ wallet
export function walletToDomain(row: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: money(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function walletToRow(wallet: Wallet, row = new WalletEntity()): WalletEntity {
  row.id = wallet.id;
  row.playerId = wallet.playerId;
  row.currency = wallet.currency;
  row.balance = wallet.balance.toString();
  row.version = wallet.version;
  row.createdAt = wallet.createdAt;
  row.updatedAt = wallet.updatedAt;
  return row;
}

// ------------------------------------------------------------- transaction
export function transactionToDomain(row: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: money(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: row.processedAt ?? undefined,
    resultBalance: row.resultBalance !== null ? money(row.resultBalance, row.currency) : undefined,
    referenceAttempts: row.referenceAttempts,
    nextReferenceAttemptAt: row.nextReferenceAttemptAt ?? undefined,
    updatedAt: row.updatedAt,
  });
}

export function transactionToRow(
  tx: WagerTransaction,
  row = new WagerTransactionEntity(),
): WagerTransactionEntity {
  row.id = tx.id;
  row.providerId = tx.providerId;
  row.externalTransactionId = tx.externalTransactionId;
  row.idempotencyKey = tx.idempotencyKey;
  row.payloadHash = tx.payloadHash;
  row.walletId = tx.walletId;
  row.playerId = tx.playerId;
  row.roundId = tx.roundId;
  row.gameId = tx.gameId;
  row.kind = tx.kind;
  row.amount = tx.money.toString();
  row.currency = tx.money.currency;
  row.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
  row.referenceTransactionId = tx.referenceTransactionId ?? null;
  row.status = tx.status;
  row.failureCode = tx.failureCode ?? null;
  row.resultBalance = tx.resultBalance?.toString() ?? null;
  row.referenceAttempts = tx.referenceAttempts;
  row.nextReferenceAttemptAt = tx.nextReferenceAttemptAt ?? null;
  row.createdAt = tx.createdAt;
  row.updatedAt = tx.updatedAt;
  row.processedAt = tx.processedAt ?? null;
  return row;
}

// ------------------------------------------------------------------ ledger
export interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

export function ledgerRowToDomain(row: LedgerRow): WalletLedgerEntry {
  const currency = row.currency.trim();
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: money(row.amount, currency),
    balanceBefore: money(row.balance_before, currency),
    balanceAfter: money(row.balance_after, currency),
    createdAt: new Date(row.created_at),
  });
}

export function ledgerToRow(entry: WalletLedgerEntry): LedgerEntryEntity {
  const row = new LedgerEntryEntity();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  row.amount = entry.money.toString();
  row.currency = entry.money.currency;
  row.balanceBefore = entry.balanceBefore.toString();
  row.balanceAfter = entry.balanceAfter.toString();
  row.createdAt = entry.createdAt;
  return row;
}

// ---------------------------------------------------------- inbox / outbox
export function inboxToDomain(row: InboxMessageEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}

export function outboxToDomain(row: OutboxMessageEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}

export function outboxToRow(message: OutboxMessage, row = new OutboxMessageEntity()): OutboxMessageEntity {
  row.id = message.id;
  row.aggregateId = message.aggregateId;
  row.eventType = message.eventType;
  row.payload = message.payload as Record<string, unknown>;
  row.occurredAt = message.occurredAt;
  row.attempts = message.attempts;
  row.nextAttemptAt = message.nextAttemptAt ?? null;
  row.publishedAt = message.publishedAt ?? null;
  return row;
}
