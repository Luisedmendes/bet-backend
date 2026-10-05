import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import { CurrencyMismatchError, Money } from '../money/money.js';
import { InsufficientFundsError, InvalidWalletMovementError, Wallet } from './wallet.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-10-05T12:00:00.000Z');
const later = new Date('2026-10-05T12:01:00.000Z');

const open = (initial = '100.00') =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'opening-tx',
    at,
  });

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with the initial balance', () => {
      const { wallet } = open('100.00');

      expect(wallet.version).toBe(1);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.currency).toBe('BRL');
    });

    it('produces an opening CREDIT entry from zero', () => {
      const { openingEntry } = open('100.00');

      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
      expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
      expect(openingEntry?.transactionId).toBe('opening-tx');
    });

    it('has no opening entry when the initial balance is zero', () => {
      const { wallet, openingEntry } = open('0.00');

      expect(openingEntry).toBeUndefined();
      expect(wallet.version).toBe(1);
    });

    it('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: 'w',
          playerId: 'p',
          initialBalance: brl('1.00').negate(),
          openingTransactionId: 't',
          at,
        }),
      ).toThrow(InvalidWalletMovementError);
    });
  });

  describe('debit', () => {
    it('reduces the balance, bumps the version and returns the ledger entry', () => {
      const { wallet } = open('100.00');

      const entry = wallet.debit(brl('80.00'), 'tx-1', later);

      expect(wallet.balance.toString()).toBe('20.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(later);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toString()).toBe('100.00');
      expect(entry.balanceAfter.toString()).toBe('20.00');
    });

    it('allows debiting the whole balance', () => {
      const { wallet } = open('100.00');

      wallet.debit(brl('100.00'), 'tx-1', later);

      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejects insufficient funds without touching the wallet', () => {
      const { wallet } = open('100.00');
      wallet.debit(brl('80.00'), 'tx-1', later);

      expect(() => wallet.debit(brl('80.00'), 'tx-2', later)).toThrow(InsufficientFundsError);
      expect(wallet.balance.toString()).toBe('20.00');
      expect(wallet.version).toBe(2);
    });

    it('rejects zero', () => {
      const { wallet } = open();

      expect(() => wallet.debit(brl('0.00'), 'tx-1', later)).toThrow(InvalidWalletMovementError);
      expect(wallet.version).toBe(1);
    });

    it('rejects a negative amount', () => {
      const { wallet } = open();

      expect(() => wallet.debit(brl('10.00').negate(), 'tx-1', later)).toThrow(
        InvalidWalletMovementError,
      );
    });

    it('rejects a different currency', () => {
      const { wallet } = open();

      expect(() => wallet.debit(usd('10.00'), 'tx-1', later)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });
  });

  describe('credit', () => {
    it('increases the balance, bumps the version and returns the ledger entry', () => {
      const { wallet } = open('20.00');

      const entry = wallet.credit(brl('50.00'), 'tx-1', later);

      expect(wallet.balance.toString()).toBe('70.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.isBalanced()).toBe(true);
    });

    it('rejects zero', () => {
      const { wallet } = open();

      expect(() => wallet.credit(brl('0.00'), 'tx-1', later)).toThrow(InvalidWalletMovementError);
    });

    it('rejects a different currency', () => {
      const { wallet } = open();

      expect(() => wallet.credit(usd('10.00'), 'tx-1', later)).toThrow(CurrencyMismatchError);
    });
  });

  describe('invariant: balance equals the ledger', () => {
    it('rebuilds the balance from the entries', () => {
      const { wallet, openingEntry } = open('100.00');
      const entries = [
        openingEntry!,
        wallet.debit(brl('25.00'), 'a', later),
        wallet.credit(brl('40.00'), 'b', later),
        wallet.debit(brl('15.50'), 'c', later),
      ];

      const rebuilt = entries.reduce(
        (total, e) =>
          e.direction === LedgerDirection.Credit ? total.add(e.money) : total.subtract(e.money),
        Money.zero('BRL'),
      );

      expect(rebuilt.equals(wallet.balance)).toBe(true);
      expect(wallet.version).toBe(4);
    });
  });

  describe('rehydrate', () => {
    it('rebuilds the persisted state as is', () => {
      const wallet = Wallet.rehydrate({
        id: 'w',
        playerId: 'p',
        currency: 'BRL',
        balance: brl('42.00'),
        version: 7,
        createdAt: at,
        updatedAt: later,
      });

      expect(wallet.balance.toString()).toBe('42.00');
      expect(wallet.version).toBe(7);
      expect(wallet.updatedAt).toEqual(later);
    });
  });
});
