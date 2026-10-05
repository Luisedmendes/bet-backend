import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
} from '../../domain/wagering/wager-transaction.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  UniqueViolationError,
  ValidationError,
  WalletNotFoundError,
} from '../errors.js';
import type { AppLogger, AppMetrics, Clock } from '../ports/observability.js';
import type { Repositories, UnitOfWork } from '../ports/repositories.js';
import { wagerPayloadHash } from '../wagering/payload-hash.js';
import type { ReferenceRetryPolicy } from '../wagering/reference-retry-policy.js';
import { settleAndRecord } from '../wagering/settle-and-record.js';
import type { WagerRequest } from '../wagering/wager-request.js';
import { outcomeOf, type WagerOutcome } from '../wagering/wager-transaction-view.js';

export interface ProcessWagerContext {
  correlationId: string;
  source: 'http' | 'sqs';
  /** Presente quando a entrada é SQS: dedup persistente por (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string };
}

/** Quantas vezes repetir quando duas requisições com a mesma key correm em wallets diferentes. */
const MAX_UNIQUE_RACE_RETRIES = 3;

/**
 * Use case único para HTTP e SQS (README §10). Tudo acontece numa transação:
 * inbox → lock da wallet → idempotência → regras → transação + ledger + saldo + outbox.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: ReferenceRetryPolicy,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  async execute(request: WagerRequest, ctx: ProcessWagerContext): Promise<WagerOutcome> {
    const startedAt = performance.now();
    const payloadHash = wagerPayloadHash(request);
    const log = {
      correlationId: ctx.correlationId,
      messageId: ctx.inbox?.messageId,
      walletId: request.walletId,
      providerId: request.providerId,
    };

    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await this.uow.run((repos) => this.process(repos, request, payloadHash, ctx));
        this.metrics.processingDuration(ctx.source, (performance.now() - startedAt) / 1000);
        if (outcome.idempotentReplay) {
          this.metrics.duplicateDetected('idempotent_replay');
        } else {
          this.metrics.transactionProcessed(outcome.status, request.kind, ctx.source);
        }
        this.logger.info('wager transaction handled', {
          ...log,
          transactionId: outcome.transactionId,
          status: outcome.status,
          failureCode: outcome.failureCode,
          idempotentReplay: outcome.idempotentReplay,
        });
        return outcome;
      } catch (error) {
        // Corrida entre wallets diferentes com a mesma key/externalId: o banco
        // barrou o segundo INSERT. Repetir encontra a transação já gravada.
        if (error instanceof UniqueViolationError && attempt < MAX_UNIQUE_RACE_RETRIES) {
          this.metrics.retry('idempotency_race');
          this.logger.warn('unique race detected, retrying', { ...log, constraint: error.constraint });
          continue;
        }
        throw error;
      }
    }
  }

  private async process(
    repos: Repositories,
    request: WagerRequest,
    payloadHash: string,
    ctx: ProcessWagerContext,
  ): Promise<WagerOutcome> {
    const now = this.clock.now();

    if (ctx.inbox) {
      const fresh = await repos.inbox.tryInsert(
        InboxMessage.receive({ ...ctx.inbox, payloadHash, at: now }),
      );
      // Inbox grava processedAt na mesma transação: existir = já foi efetivada.
      if (!fresh) {
        this.metrics.duplicateDetected('inbox_message');
        const previous = await repos.transactions.findByIdempotencyKey(request.idempotencyKey);
        if (previous && previous.matchesPayload(payloadHash)) {
          return outcomeOf(previous, true);
        }
        throw new IdempotencyConflictError(
          `Message ${ctx.inbox.messageId} was already consumed with a different payload`,
        );
      }
    }

    // Lock por wallet: serializa operações da mesma wallet entre todas as instâncias.
    const wallet = await repos.wallets.findByIdForUpdate(request.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${request.walletId} not found`);
    }

    const existing = await repos.transactions.findByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(
          `Idempotency-Key ${request.idempotencyKey} was used with a different payload`,
        );
      }
      return outcomeOf(existing, true);
    }

    const sameExternalId = await repos.transactions.findByExternalId(
      request.providerId,
      request.externalTransactionId,
    );
    if (sameExternalId) {
      throw new ExternalTransactionConflictError(
        `Transaction ${request.providerId}/${request.externalTransactionId} already exists under another Idempotency-Key`,
      );
    }

    let tx: WagerTransaction;
    try {
      tx = WagerTransaction.create({ ...request, payloadHash, at: now });
    } catch (error) {
      if (error instanceof InvalidWagerTransactionError) throw new ValidationError(error.message);
      throw error;
    }

    await settleAndRecord({
      repos,
      transaction: tx,
      wallet,
      isNew: true,
      policy: this.policy,
      ctx: { correlationId: ctx.correlationId, causationId: ctx.inbox?.messageId, at: now },
    });

    return outcomeOf(tx, false);
  }
}
