import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from '../money/money.js';
import { LedgerDirection } from './ledger-direction.js';
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-05T12:00:00.000Z');

const debit = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  at,
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('creates a valid debit', () => {
      const entry = WalletLedgerEntry.create(debit());

      expect(entry.balanceAfter.toString()).toBe('20.00');
      expect(entry.createdAt).toEqual(at);
    });

    it('creates a valid credit', () => {
      const entry = WalletLedgerEntry.create(
        debit({
          direction: LedgerDirection.Credit,
          money: brl('50.00'),
          balanceBefore: brl('20.00'),
          balanceAfter: brl('70.00'),
        }),
      );

      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceAfter.toString()).toBe('70.00');
    });

    it('generates a non-empty id', () => {
      expect(WalletLedgerEntry.create(debit()).id).toBeString();
      expect(WalletLedgerEntry.create(debit()).id.length).toBeGreaterThan(0);
    });

    it('generates different ids for different entries', () => {
      expect(WalletLedgerEntry.create(debit()).id).not.toBe(WalletLedgerEntry.create(debit()).id);
    });

    it('rejects a debit whose arithmetic does not match', () => {
      expect(() => WalletLedgerEntry.create(debit({ balanceAfter: brl('30.00') }))).toThrow(
        InvalidLedgerEntryError,
      );
    });

    it('rejects a credit whose arithmetic does not match', () => {
      expect(() =>
        WalletLedgerEntry.create(
          debit({ direction: LedgerDirection.Credit, balanceAfter: brl('20.00') }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejects zero money', () => {
      expect(() =>
        WalletLedgerEntry.create(debit({ money: brl('0.00'), balanceAfter: brl('100.00') })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejects negative money', () => {
      expect(() =>
        WalletLedgerEntry.create(debit({ money: brl('80.00').negate(), balanceAfter: brl('180.00') })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejects a negative balanceAfter', () => {
      expect(() =>
        WalletLedgerEntry.create(
          debit({ balanceBefore: brl('50.00'), balanceAfter: brl('30.00').negate() }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejects money in a different currency', () => {
      expect(() =>
        WalletLedgerEntry.create(debit({ money: Money.from({ amount: '80.00', currency: 'USD' }) })),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe('isBalanced', () => {
    it('is true for a valid entry', () => {
      expect(WalletLedgerEntry.create(debit()).isBalanced()).toBe(true);
    });
  });

  describe('rehydrate', () => {
    const state = {
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: brl('80.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('20.00'),
      createdAt: at,
    };

    it('keeps the given id and createdAt', () => {
      const entry = WalletLedgerEntry.rehydrate(state);

      expect(entry.id).toBe('entry-1');
      expect(entry.createdAt).toEqual(at);
    });

    it('does not validate (an unbalanced state is rebuilt without error)', () => {
      const entry = WalletLedgerEntry.rehydrate({ ...state, balanceAfter: brl('99.00') });

      expect(entry.isBalanced()).toBe(false);
    });
  });
});
