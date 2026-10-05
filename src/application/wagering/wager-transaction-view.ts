import type { MoneyProps } from '../../domain/money/money.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';

/** Resultado devolvido ao provedor (HTTP) e usado pelo consumidor SQS. */
export interface WagerOutcome {
  transactionId: string;
  status: string;
  /** Ausente só em FAILED, que não chega a observar o saldo. */
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

export function outcomeOf(tx: WagerTransaction, idempotentReplay: boolean): WagerOutcome {
  return {
    transactionId: tx.id,
    status: tx.status,
    // Saldo observado quando a transação foi decidida — não o saldo atual (README §7, regra 7).
    ...(tx.resultBalance ? { balance: tx.resultBalance.toJSON() } : {}),
    idempotentReplay,
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
  };
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  resultBalance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export function viewOf(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.resultBalance ? { resultBalance: tx.resultBalance.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}
