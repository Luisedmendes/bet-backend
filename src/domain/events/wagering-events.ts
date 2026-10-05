import type { LedgerDirection } from '../ledger/ledger-direction.js';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import type { MoneyProps } from '../money/money.js';
import type { FailureCode } from '../wagering/failure-code.js';
import type { WagerTransaction } from '../wagering/wager-transaction.js';
import type { Wallet } from '../wallet/wallet.js';
import { type EventContext, IntegrationEvent } from './integration-event.js';

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(tx: WagerTransaction): TransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.propsFrom(tx.walletId, ctx, {
        ...transactionData(tx),
        ...(tx.referenceTransactionId !== undefined
          ? { referenceTransactionId: tx.referenceTransactionId }
          : {}),
        balance: tx.resultBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.propsFrom(tx.walletId, ctx, {
        ...transactionData(tx),
        failureCode: tx.failureCode!,
        balance: tx.resultBalance!.toJSON(),
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  attempts: number;
  nextAttemptAt: string;
}

/** Referência ausente: a transação aguarda reprocessamento. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.propsFrom(tx.walletId, ctx, {
        ...transactionData(tx),
        attempts: tx.referenceAttempts,
        nextAttemptAt: tx.nextReferenceAttemptAt!.toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. walletVersion permite ao consumidor ordenar e descartar duplicatas. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.propsFrom(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
