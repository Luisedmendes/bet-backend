import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wagering-events.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { InvalidMoneyError, Money } from '../../domain/money/money.js';
import { newId } from '../../domain/shared/id.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { UniqueViolationError, ValidationError, WalletAlreadyExistsError } from '../errors.js';
import type { AppLogger, Clock } from '../ports/observability.js';
import type { UnitOfWork } from '../ports/repositories.js';
import { canonicalJson, sha256Hex } from '../wagering/payload-hash.js';
import { isUuid } from '../wagering/wager-request.js';

export interface CreateWalletRequest {
  playerId: string;
  initialBalance: Money;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export function walletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function parseCreateWalletRequest(body: unknown): CreateWalletRequest {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];
  if (!isUuid(input.playerId)) errors.push('playerId must be a UUID');

  let initialBalance: Money | undefined;
  const raw = input.initialBalance as Record<string, unknown> | undefined;
  if (typeof raw !== 'object' || raw === null) {
    errors.push('initialBalance must be an object { amount, currency }');
  } else {
    try {
      initialBalance = Money.from({ amount: raw.amount as string, currency: raw.currency as string });
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      errors.push(`initialBalance: ${error.message}`);
    }
  }

  if (errors.length > 0 || !initialBalance) {
    throw new ValidationError('Invalid wallet payload', errors);
  }
  return { playerId: (input.playerId as string).toLowerCase(), initialBalance };
}

/**
 * Cria a wallet. Saldo inicial > 0 gera uma transação interna OPENING e o
 * lançamento CREDIT na MESMA transação SQL (README §9).
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async execute(request: CreateWalletRequest, correlationId: string): Promise<WalletView> {
    const now = this.clock.now();
    const walletId = newId();
    const opening = WagerTransaction.opening({
      walletId,
      playerId: request.playerId,
      money: request.initialBalance,
      payloadHash: sha256Hex(
        canonicalJson({ walletId, playerId: request.playerId, money: request.initialBalance.toJSON() }),
      ),
      at: now,
    });
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: request.playerId,
      initialBalance: request.initialBalance,
      openingTransactionId: opening.id,
      at: now,
    });

    try {
      await this.uow.run(async (repos) => {
        repos.wallets.insert(wallet);
        if (openingEntry) {
          opening.markProcessed(undefined, now, wallet.balance);
          repos.transactions.insert(opening);
          repos.ledger.append(openingEntry);
          const ctx = { correlationId, causationId: opening.id, at: now };
          repos.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)));
          repos.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)));
        }
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        throw new WalletAlreadyExistsError(
          `Player ${request.playerId} already has a ${request.initialBalance.currency} wallet`,
        );
      }
      throw error;
    }

    this.logger.info('wallet created', { correlationId, walletId: wallet.id });
    return walletView(wallet);
  }
}
