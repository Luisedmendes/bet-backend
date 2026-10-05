import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { InsufficientFundsError, Wallet } from '../wallet/wallet.js';
import { FailureCode } from './failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

export interface SettleInput {
  transaction: WagerTransaction;
  /** Wallet já travada pelo chamador (lock por walletId). */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se não existe. */
  reference: WagerTransaction | undefined;
  /** Já existe uma reversão PROCESSED apontando para a referência. */
  referenceAlreadyReversed: boolean;
  at: Date;
  /** Quando tentar de novo se a referência não estiver disponível. */
  nextReferenceAttemptAt: Date;
  /** Esgotou o limite de tentativas de resolver a referência (README §7.1). */
  referenceAttemptsExhausted: boolean;
}

export interface SettleResult {
  status: WagerTransactionStatus;
  /** Lançamento gerado quando o saldo mudou. */
  entry: WalletLedgerEntry | undefined;
}

/**
 * Regras de negócio de BET / WIN / LOSS / REFUND / ROLLBACK (README §7).
 * Função pura sobre objetos de domínio: não sabe de banco, lock ou HTTP.
 * Muda o estado de `transaction` (e de `wallet`, quando aplica).
 */
export function settleWagerTransaction(input: SettleInput): SettleResult {
  const { transaction: tx, wallet, at } = input;
  const reject = (code: FailureCode): SettleResult => {
    tx.reject(code, at, wallet.balance);
    return { status: tx.status, entry: undefined };
  };

  if (tx.playerId !== wallet.playerId || tx.walletId !== wallet.id) {
    return reject(FailureCode.PlayerWalletMismatch);
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }
  if (tx.affectsBalance() && !tx.money.isPositive()) {
    return reject(FailureCode.InvalidAmount);
  }

  const reference = input.reference;
  if (tx.referenceExternalTransactionId !== undefined) {
    const available =
      reference !== undefined &&
      reference.status !== WagerTransactionStatus.Pending &&
      reference.status !== WagerTransactionStatus.PendingReference;

    if (!available) {
      // README §7.1: espera a referência até o limite; depois rejeita.
      if (input.referenceAttemptsExhausted) {
        return reject(FailureCode.ReferenceNotFound);
      }
      tx.markPendingReference(input.nextReferenceAttemptAt, at, wallet.balance);
      return { status: tx.status, entry: undefined };
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (!tx.acceptsReferenceKind(reference.kind)) {
      return reject(FailureCode.ReferenceInvalidKind);
    }
    if (
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) {
        return reject(FailureCode.ReferenceAmountMismatch);
      }
      if (input.referenceAlreadyReversed) {
        return reject(FailureCode.AlreadyReversed);
      }
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, at, wallet.balance);
    return { status: tx.status, entry: undefined };
  }

  let entry: WalletLedgerEntry;
  try {
    entry = wallet.move(tx.ledgerDirectionFor(reference), tx.money, tx.id, at);
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      // README §7, regra 9: reversão sem saldo tem código próprio.
      return reject(
        tx.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalInsufficientFunds,
      );
    }
    throw error;
  }

  tx.markProcessed(reference?.id, at, wallet.balance);
  return { status: tx.status, entry };
}
