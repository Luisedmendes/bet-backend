import { Money } from '../money/money.js';
import { DomainError } from '../shared/domain-error.js';
import { newId } from '../shared/id.js';
import { LedgerDirection } from './ledger-direction.js';

export class InvalidLedgerEntryError extends DomainError {}

/** O que é preciso para criar um lançamento novo. */
export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  at: Date;
}

/** Um lançamento que já existe (vindo do banco). */
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger: só campos readonly e nenhum método que
 * altere estado. Correções são novos lançamentos (ex.: ROLLBACK).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Gera o id, valida tudo e cria. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry money must be positive');
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry would leave a negative balance');
    }

    const entry = new WalletLedgerEntry(
      newId(),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.at,
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced ledger entry: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} != ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrói a partir do banco. NÃO valida (README §6.0). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
