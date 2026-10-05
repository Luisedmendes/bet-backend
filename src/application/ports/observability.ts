/** Campos de contexto que acompanham os logs (nunca payloads financeiros completos). */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface AppMetrics {
  transactionProcessed(status: string, kind: string, source: string): void;
  duplicateDetected(kind: 'idempotent_replay' | 'inbox_message'): void;
  retry(component: 'idempotency_race' | 'sqs_consumer' | 'outbox' | 'pending_reference'): void;
  dlqMessage(reason: string): void;
  lockConflict(reason: string): void;
  processingDuration(source: string, seconds: number): void;
  outboxLag(pending: number, oldestAgeSeconds: number): void;
  outboxPublished(count: number): void;
  reconciliationDivergence(): void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
