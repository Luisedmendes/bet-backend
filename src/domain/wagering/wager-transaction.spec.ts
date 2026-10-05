import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import { Money } from '../money/money.js';
import { FailureCode } from './failure-code.js';
import {
  type CreateWagerTransactionProps,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-05T12:00:00.000Z');

const props = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  idempotencyKey: 'provider-a:tx-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: Kind.Bet,
  money: brl('25.00'),
  at,
  ...overrides,
});

describe('WagerTransaction', () => {
  describe('create', () => {
    it('is born PENDING with a generated id', () => {
      const tx = WagerTransaction.create(props());

      expect(tx.status).toBe(Status.Pending);
      expect(tx.id).toBeString();
      expect(tx.isTerminal()).toBe(false);
    });

    it.each([Kind.Refund, Kind.Rollback])('requires a reference for %p', (kind) => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerTransactionError);
    });

    it('accepts a reference for REFUND', () => {
      const tx = WagerTransaction.create(
        props({ kind: Kind.Refund, externalTransactionId: 'tx-2', referenceExternalTransactionId: 'tx-1' }),
      );

      expect(tx.referenceExternalTransactionId).toBe('tx-1');
    });

    it('rejects OPENING from outside', () => {
      expect(() => WagerTransaction.create(props({ kind: Kind.Opening }))).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('rejects the reserved internal provider', () => {
      expect(() => WagerTransaction.create(props({ providerId: 'internal' }))).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('rejects a self reference', () => {
      expect(() =>
        WagerTransaction.create(props({ kind: Kind.Rollback, referenceExternalTransactionId: 'tx-1' })),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('opening', () => {
    it('is an internal OPENING credit', () => {
      const tx = WagerTransaction.opening({
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('100.00'),
        payloadHash: 'h',
        at,
      });

      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.providerId).toBe('internal');
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('transitions', () => {
    it('markProcessed sets processedAt, reference and result balance', () => {
      const tx = WagerTransaction.create(props());

      tx.markProcessed('ref-id', at, brl('75.00'));

      expect(tx.status).toBe(Status.Processed);
      expect(tx.processedAt).toEqual(at);
      expect(tx.referenceTransactionId).toBe('ref-id');
      expect(tx.resultBalance?.toString()).toBe('75.00');
    });

    it('reject stores the failure code', () => {
      const tx = WagerTransaction.create(props());

      tx.reject(FailureCode.InsufficientFunds, at, brl('10.00'));

      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    it('markPendingReference counts attempts and can be repeated', () => {
      const tx = WagerTransaction.create(props());
      const next = new Date('2026-10-05T12:00:01.000Z');

      tx.markPendingReference(next, at, brl('10.00'));
      tx.markPendingReference(next, at, brl('10.00'));

      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.referenceAttempts).toBe(2);
      expect(tx.nextReferenceAttemptAt).toEqual(next);
    });

    it('PENDING_REFERENCE can still be processed', () => {
      const tx = WagerTransaction.create(props());
      tx.markPendingReference(at, at, brl('10.00'));

      tx.markProcessed(undefined, at, brl('10.00'));

      expect(tx.status).toBe(Status.Processed);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    });

    it.each([
      ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, at, brl('1.00'))],
      ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InvalidAmount, at, brl('1.00'))],
      ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingError, at)],
    ])('a %s transaction cannot change anymore', (_name, terminate) => {
      const tx = WagerTransaction.create(props());
      terminate(tx);

      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InvalidAmount, at, brl('1.00'))).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference(at, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.ProcessingError, at)).toThrow(InvalidTransactionStateError);
    });
  });

  describe('queries', () => {
    it('LOSS does not affect the balance', () => {
      expect(WagerTransaction.create(props({ kind: Kind.Loss })).affectsBalance()).toBe(false);
      expect(WagerTransaction.create(props({ kind: Kind.Bet })).affectsBalance()).toBe(true);
    });

    it('matchesPayload compares the hash', () => {
      const tx = WagerTransaction.create(props());

      expect(tx.matchesPayload('hash-1')).toBe(true);
      expect(tx.matchesPayload('other')).toBe(false);
    });

    it('ROLLBACK goes in the opposite direction of its reference', () => {
      const bet = WagerTransaction.create(props());
      const win = WagerTransaction.create(props({ kind: Kind.Win, externalTransactionId: 'w' }));
      const rollback = WagerTransaction.create(
        props({ kind: Kind.Rollback, externalTransactionId: 'r', referenceExternalTransactionId: 'tx-1' }),
      );

      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    });
  });
});
