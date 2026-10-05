import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransientInfrastructureError,
  ValidationError,
  WalletNotFoundError,
} from '../../application/errors.js';
import type { AppLogger } from '../../application/ports/observability.js';
import type { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { parseWagerRequest } from '../../application/wagering/wager-request.js';
import { runWithLogContext } from '../observability/json-logger.js';

/**
 * O que fazer com a mensagem depois de tratada:
 * - ack:   efeito decidido e commitado (PROCESSED / REJECTED / PENDING_REFERENCE) ou replay;
 * - retry: falha transitória — devolve à fila com backoff; após maxReceiveCount o SQS manda à DLQ;
 * - dlq:   nunca vai dar certo como está (payload inválido, conflito, wallet inexistente).
 */
export type HandlingDecision =
  | { action: 'ack'; status: string }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string };

export interface WagerMessageEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt?: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

export class WagerMessageHandler {
  constructor(
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly consumerName: string,
    private readonly logger: AppLogger,
  ) {}

  async handle(body: string | undefined): Promise<HandlingDecision> {
    const envelope = parseEnvelope(body);
    if (!envelope) {
      return { action: 'dlq', reason: 'malformed_message' };
    }

    return runWithLogContext(
      { correlationId: envelope.correlationId ?? envelope.messageId, messageId: envelope.messageId },
      async () => {
        try {
          const request = parseWagerRequest(envelope.data, envelope.data.idempotencyKey);
          const outcome = await this.useCase.execute(request, {
            correlationId: envelope.correlationId ?? envelope.messageId,
            source: 'sqs',
            inbox: { consumerName: this.consumerName, messageId: envelope.messageId },
          });
          return { action: 'ack', status: outcome.status } as const;
        } catch (error) {
          return this.classify(error);
        }
      },
    );
  }

  private classify(error: unknown): HandlingDecision {
    if (error instanceof ValidationError) {
      this.logger.warn('invalid wager message', { details: error.details });
      return { action: 'dlq', reason: 'validation_error' };
    }
    if (error instanceof IdempotencyConflictError || error instanceof ExternalTransactionConflictError) {
      this.logger.warn('conflicting wager message', { code: error.code });
      return { action: 'dlq', reason: error.code.toLowerCase() };
    }
    if (error instanceof WalletNotFoundError) {
      this.logger.warn('wager message for unknown wallet');
      return { action: 'dlq', reason: 'wallet_not_found' };
    }
    if (error instanceof TransientInfrastructureError) {
      this.logger.warn('transient failure, message will be retried', { reason: error.reason });
      return { action: 'retry', reason: error.reason };
    }
    // Erro inesperado: tratado como transitório. Se persistir, o redrive do SQS leva à DLQ.
    this.logger.error('unexpected failure handling wager message', {
      error: (error as Error)?.message,
    });
    return { action: 'retry', reason: 'unexpected_error' };
  }
}

function parseEnvelope(body: string | undefined): WagerMessageEnvelope | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as Partial<WagerMessageEnvelope>;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.type !== 'WagerTransactionRequested' ||
      typeof parsed.messageId !== 'string' ||
      parsed.messageId.trim() === '' ||
      typeof parsed.data !== 'object' ||
      parsed.data === null
    ) {
      return undefined;
    }
    return parsed as WagerMessageEnvelope;
  } catch {
    return undefined;
  }
}
