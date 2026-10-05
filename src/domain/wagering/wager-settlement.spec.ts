import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import { Money } from '../money/money.js';
import { Wallet } from '../wallet/wallet.js';
import { FailureCode } from './failure-code.js';
import { type SettleInput, settleWagerTransaction } from './wager-settlement.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-10-05T12:00:00.000Z');
const next = new Date('2026-10-05T12:00:05.000Z');

const wallet = (balance = '100.00') =>
  Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(balance), openingTransactionId: 'o', at })
    .wallet;

let seq = 0;
const tx = (overrides: Partial<CreateWagerTransactionProps> = {}) => {
  seq += 1;
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: `tx-${seq}`,
    idempotencyKey: `provider-a:tx-${seq}`,
    payloadHash: 'h',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    at,
    ...overrides,
  });
};

const processed = (overrides: Partial<CreateWagerTransactionProps> = {}) => {
  const t = tx(overrides);
  t.markProcessed(undefined, at, brl('0.00'));
  return t;
};

const settle = (input: Partial<SettleInput> & Pick<SettleInput, 'transaction' | 'wallet'>) =>
  settleWagerTransaction({
    reference: undefined,
    referenceAlreadyReversed: false,
    at,
    nextReferenceAttemptAt: next,
    referenceAttemptsExhausted: false,
    ...input,
  });

describe('settleWagerTransaction', () => {
  describe('BET', () => {
    it('debits the wallet and produces one DEBIT entry', () => {
      const w = wallet('100.00');
      const bet = tx({ money: brl('80.00') });

      const result = settle({ transaction: bet, wallet: w });

      expect(result.status).toBe(Status.Processed);
      expect(result.entry?.direction).toBe(LedgerDirection.Debit);
      expect(w.balance.toString()).toBe('20.00');
      expect(bet.resultBalance?.toString()).toBe('20.00');
    });

    it('is rejected with INSUFFICIENT_FUNDS and no entry', () => {
      const w = wallet('20.00');
      const bet = tx({ money: brl('80.00') });

      const result = settle({ transaction: bet, wallet: w });

      expect(result.status).toBe(Status.Rejected);
      expect(result.entry).toBeUndefined();
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(w.balance.toString()).toBe('20.00');
      expect(w.version).toBe(1);
    });

    it('is rejected with INVALID_AMOUNT for zero', () => {
      const bet = tx({ money: brl('0.00') });

      settle({ transaction: bet, wallet: wallet() });

      expect(bet.failureCode).toBe(FailureCode.InvalidAmount);
    });
  });

  describe('currency and ownership', () => {
    it('rejects a currency different from the wallet', () => {
      const w = wallet();
      const bet = tx({ money: usd('10.00') });

      settle({ transaction: bet, wallet: w });

      expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(w.version).toBe(1);
    });

    it('rejects a player that does not own the wallet', () => {
      const bet = tx({ playerId: 'someone-else' });

      settle({ transaction: bet, wallet: wallet() });

      expect(bet.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    });
  });

  describe('WIN', () => {
    it('credits the wallet without a reference', () => {
      const w = wallet('100.00');

      const result = settle({ transaction: tx({ kind: Kind.Win, money: brl('50.00') }), wallet: w });

      expect(result.entry?.direction).toBe(LedgerDirection.Credit);
      expect(w.balance.toString()).toBe('150.00');
    });

    it('can reference the BET of the same round', () => {
      const bet = processed();
      const win = tx({ kind: Kind.Win, referenceExternalTransactionId: bet.externalTransactionId });

      settle({ transaction: win, wallet: wallet(), reference: bet });

      expect(win.status).toBe(Status.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
    });
  });

  describe('LOSS', () => {
    it('is processed without touching the balance or the ledger', () => {
      const w = wallet('100.00');
      const loss = tx({ kind: Kind.Loss, money: brl('0.00') });

      const result = settle({ transaction: loss, wallet: w });

      expect(result.status).toBe(Status.Processed);
      expect(result.entry).toBeUndefined();
      expect(w.balance.toString()).toBe('100.00');
      expect(w.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    it('credits back a processed BET', () => {
      const w = wallet('75.00');
      const bet = processed();
      const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });

      const result = settle({ transaction: refund, wallet: w, reference: bet });

      expect(result.entry?.direction).toBe(LedgerDirection.Credit);
      expect(w.balance.toString()).toBe('100.00');
    });

    it('only references BET', () => {
      const win = processed({ kind: Kind.Win });
      const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: win.externalTransactionId });

      settle({ transaction: refund, wallet: wallet(), reference: win });

      expect(refund.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    });

    it('must have the same amount as the reference', () => {
      const bet = processed();
      const refund = tx({
        kind: Kind.Refund,
        money: brl('10.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });

      settle({ transaction: refund, wallet: wallet(), reference: bet });

      expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    });

    it('cannot revert the same reference twice', () => {
      const bet = processed();
      const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });

      settle({ transaction: refund, wallet: wallet(), reference: bet, referenceAlreadyReversed: true });

      expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
    });

    it('rejects a reference from another round', () => {
      const bet = processed({ roundId: 'round-2' });
      const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });

      settle({ transaction: refund, wallet: wallet(), reference: bet });

      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    });

    it('rejects a reference that was not processed', () => {
      const bet = tx();
      bet.reject(FailureCode.InsufficientFunds, at, brl('0.00'));
      const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });

      settle({ transaction: refund, wallet: wallet(), reference: bet });

      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });
  });

  describe('ROLLBACK', () => {
    it('credits back a BET', () => {
      const w = wallet('75.00');
      const bet = processed();
      const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: bet.externalTransactionId });

      const result = settle({ transaction: rollback, wallet: w, reference: bet });

      expect(result.entry?.direction).toBe(LedgerDirection.Credit);
      expect(w.balance.toString()).toBe('100.00');
    });

    it('debits back a WIN', () => {
      const w = wallet('100.00');
      const win = processed({ kind: Kind.Win });
      const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: win.externalTransactionId });

      const result = settle({ transaction: rollback, wallet: w, reference: win });

      expect(result.entry?.direction).toBe(LedgerDirection.Debit);
      expect(w.balance.toString()).toBe('75.00');
    });

    it('is rejected with REVERSAL_INSUFFICIENT_FUNDS, distinct from a BET', () => {
      const w = wallet('10.00');
      const win = processed({ kind: Kind.Win });
      const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: win.externalTransactionId });

      settle({ transaction: rollback, wallet: w, reference: win });

      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(w.balance.toString()).toBe('10.00');
    });

    it('does not reference LOSS or another ROLLBACK', () => {
      const loss = processed({ kind: Kind.Loss });
      const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: loss.externalTransactionId });

      settle({ transaction: rollback, wallet: wallet(), reference: loss });

      expect(rollback.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    });
  });

  describe('out of order references', () => {
    it('waits as PENDING_REFERENCE when the reference is missing', () => {
      const w = wallet();
      const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'not-yet' });

      const result = settle({ transaction: rollback, wallet: w });

      expect(result.status).toBe(Status.PendingReference);
      expect(rollback.nextReferenceAttemptAt).toEqual(next);
      expect(w.version).toBe(1);
    });

    it('waits while the reference itself is pending', () => {
      const pendingBet = tx();
      pendingBet.markPendingReference(next, at, brl('0.00'));
      const refund = tx({ kind: Kind.Refund, referenceExternalTransactionId: pendingBet.externalTransactionId });

      settle({ transaction: refund, wallet: wallet(), reference: pendingBet });

      expect(refund.status).toBe(Status.PendingReference);
    });

    it('is rejected with REFERENCE_NOT_FOUND once attempts are exhausted', () => {
      const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'never' });

      settle({ transaction: rollback, wallet: wallet(), referenceAttemptsExhausted: true });

      expect(rollback.failureCode).toBe(FailureCode.ReferenceNotFound);
    });
  });
});
