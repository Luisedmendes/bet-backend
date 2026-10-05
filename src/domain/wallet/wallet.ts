import { LedgerDirection } from '../ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { CurrencyMismatchError, Money } from '../money/money.js';
import { DomainError } from '../shared/domain-error.js';

export class InsufficientFundsError extends DomainError {}
export class InvalidWalletMovementError extends DomainError {}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação OPENING interna que justifica o saldo inicial (se > 0). */
  openingTransactionId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento CREDIT do saldo inicial; ausente quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate root: única forma de alterar o saldo. Cada alteração devolve o
 * lançamento correspondente no ledger (D8) e incrementa a version.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version 1. O saldo inicial não
   * passa por credit() para que a version comece em 1 (README §6.2).
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletMovementError('Initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );

    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: props.initialBalance,
          at: props.at,
        })
      : undefined;

    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lança InsufficientFundsError se o saldo não cobrir o débito (D9). */
  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertMovement(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(
        `Insufficient funds: balance ${this._balance.toString()}, debit ${money.toString()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertMovement(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  /** Aplica no sentido pedido; usado por ROLLBACK, que inverte a referência. */
  move(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    return direction === LedgerDirection.Debit
      ? this.debit(money, transactionId, at)
      : this.credit(money, transactionId, at);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    at: Date,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit ? balanceBefore.subtract(money) : balanceBefore.add(money);

    // Cria o lançamento antes de mutar: se ele for inválido, a wallet fica intacta.
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  /** D10: só valores positivos, na moeda da wallet. */
  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletMovementError(`Movement must be positive, got ${money.toString()}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Currency mismatch: wallet ${this.currency} vs ${money.currency}`,
      );
    }
  }
}
