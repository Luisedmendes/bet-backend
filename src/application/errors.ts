/**
 * Erros da camada de aplicação. Cada um vira um status HTTP distinto e uma
 * decisão distinta no consumidor SQS (ack, retry ou DLQ).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Payload inválido. Reenviar igual não adianta: corrigir o payload. */
export class ValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';

  constructor(
    message: string,
    readonly details: string[] = [message],
  ) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

/** Mesma Idempotency-Key com payload diferente: conflito, não replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** Mesmo (providerId, externalTransactionId) enviado com outra Idempotency-Key. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** Falha temporária de infraestrutura (banco fora, lock timeout, deadlock). Pode reenviar. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';

  constructor(
    message: string,
    readonly reason: 'unavailable' | 'lock_timeout' | 'deadlock' | 'serialization',
  ) {
    super(message);
  }
}

/**
 * Violação de unicidade levantada pela persistência. O use case decide o que
 * significa (corrida de idempotência, wallet duplicada...).
 */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`);
  }
}
