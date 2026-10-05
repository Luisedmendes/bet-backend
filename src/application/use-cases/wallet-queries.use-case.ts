import type { MoneyProps } from '../../domain/money/money.js';
import { TransactionNotFoundError, ValidationError, WalletNotFoundError } from '../errors.js';
import type { AppLogger, AppMetrics } from '../ports/observability.js';
import type { UnitOfWork } from '../ports/repositories.js';
import { viewOf, type WagerTransactionView } from '../wagering/wager-transaction-view.js';
import { walletView, type WalletView } from './create-wallet.use-case.js';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Cursor opaco: base64url de { s: seq }. O cliente só devolve o que recebeu. */
export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'string' && /^\d+$/.test(parsed.s)) return parsed.s;
  } catch {
    // cai no erro abaixo
  }
  throw new ValidationError('Invalid cursor');
}

export class WalletQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    return walletView(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterSeq = cursor ? decodeCursor(cursor) : undefined;
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
      const page = await repos.ledger.page(walletId, afterSeq, limit);
      return {
        walletId,
        entries: page.entries.map(({ entry }) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      };
    });
  }

  async getTransaction(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError(`Transaction ${transactionId} not found`);
    return viewOf(tx);
  }

  async getTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run((repos) => repos.transactions.findByExternalId(providerId, externalId));
    if (!tx) throw new TransactionNotFoundError(`Transaction ${providerId}/${externalId} not found`);
    return viewOf(tx);
  }

  /**
   * Compara o saldo materializado com o saldo reconstruído pelo ledger.
   * Divergência nunca é corrigida aqui: é logada, contada em métrica e devolvida.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationView> {
    const view = await this.uow.run(async (repos) => {
      // FOR SHARE: ninguém altera a wallet enquanto lemos saldo e ledger.
      const wallet = await repos.wallets.findByIdForShare(walletId);
      if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
      const totals = await repos.ledger.totals(walletId, wallet.currency);
      const calculated = totals.credits.subtract(totals.debits);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: totals.count,
      };
    });

    if (!view.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('reconciliation divergence detected', {
        correlationId,
        walletId,
        difference: view.difference.amount,
      });
    }
    return view;
  }
}
