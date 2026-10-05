import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { AppMetrics } from '../../application/ports/observability.js';

/** Métricas expostas em GET /metrics (formato Prometheus). */
export class PrometheusMetrics implements AppMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions decided, by status, kind and source',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicates detected (idempotent replays and inbox redeliveries)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries by component',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages sent to the DLQ by this service, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and serialization failures',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Outbox messages not yet published',
    registers: [this.registry],
  });
  private readonly outboxLagSeconds = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox messages published',
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Wallets whose stored balance differs from the ledger',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionProcessed(status: string, kind: string, source: string): void {
    this.transactions.inc({ status, kind, source });
  }
  duplicateDetected(kind: 'idempotent_replay' | 'inbox_message'): void {
    this.duplicates.inc({ kind });
  }
  retry(component: string): void {
    this.retries.inc({ component });
  }
  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  processingDuration(source: string, seconds: number): void {
    this.duration.observe({ source }, seconds);
  }
  outboxLag(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLagSeconds.set(oldestAgeSeconds);
  }
  outboxPublished(count: number): void {
    this.outboxPublishedTotal.inc(count);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
