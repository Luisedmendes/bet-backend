/**
 * Configuração tipada e validada no boot (fail fast). O Bun carrega o `.env`
 * sozinho, então não há dotenv.
 */
export interface AppEnv {
  port: number;
  instanceId: string;
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
    poolMax: number;
    lockTimeoutMs: number;
  };
  sqs: {
    region: string;
    endpoint: string | undefined;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    consumerName: string;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
  };
  workers: {
    sqsConsumer: boolean;
    outboxPublisher: boolean;
    pendingReferences: boolean;
    outboxIntervalMs: number;
    pendingReferencesIntervalMs: number;
    shutdownDrainMs: number;
  };
  references: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

type Source = Record<string, string | undefined>;

function required(source: Source, key: string): string {
  const value = source[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(source: Source, key: string, fallback: string): string {
  const value = source[key];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function integer(source: Source, key: string, fallback: number): number {
  const raw = optional(source, key, String(fallback));
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Environment variable ${key} must be a non-negative integer, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

function bool(source: Source, key: string, fallback: boolean): boolean {
  const raw = optional(source, key, String(fallback)).toLowerCase();
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Environment variable ${key} must be true or false, got "${raw}"`);
  }
  return raw === 'true';
}

export function loadEnv(source: Source = process.env): AppEnv {
  return {
    port: integer(source, 'PORT', 3000),
    instanceId: optional(source, 'INSTANCE_ID', source['HOSTNAME'] || `instance-${process.pid}`),
    database: {
      host: optional(source, 'POSTGRES_HOST', '127.0.0.1'),
      port: integer(source, 'POSTGRES_PORT', 5432),
      user: required(source, 'POSTGRES_USER'),
      password: required(source, 'POSTGRES_PASSWORD'),
      name: required(source, 'POSTGRES_DB'),
      poolMax: integer(source, 'DB_POOL_MAX', 10),
      lockTimeoutMs: integer(source, 'DB_LOCK_TIMEOUT_MS', 5_000),
    },
    sqs: {
      region: optional(source, 'AWS_REGION', 'us-east-1'),
      endpoint: source['SQS_ENDPOINT'] || undefined,
      wagerQueueName: optional(source, 'SQS_WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      wagerDlqName: optional(source, 'SQS_WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      eventsQueueName: optional(source, 'SQS_EVENTS_QUEUE_NAME', 'wagering-events.fifo'),
      consumerName: optional(source, 'SQS_CONSUMER_NAME', 'wager-transactions-consumer'),
      waitTimeSeconds: integer(source, 'SQS_WAIT_TIME_SECONDS', 10),
      visibilityTimeoutSeconds: integer(source, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
    },
    workers: {
      sqsConsumer: bool(source, 'WORKER_SQS_CONSUMER', true),
      outboxPublisher: bool(source, 'WORKER_OUTBOX_PUBLISHER', true),
      pendingReferences: bool(source, 'WORKER_PENDING_REFERENCES', true),
      outboxIntervalMs: integer(source, 'OUTBOX_INTERVAL_MS', 500),
      pendingReferencesIntervalMs: integer(source, 'PENDING_REFERENCES_INTERVAL_MS', 1_000),
      shutdownDrainMs: integer(source, 'SHUTDOWN_DRAIN_MS', 20_000),
    },
    references: {
      maxAttempts: integer(source, 'REFERENCE_MAX_ATTEMPTS', 10),
      baseDelayMs: integer(source, 'REFERENCE_BASE_DELAY_MS', 1_000),
      maxDelayMs: integer(source, 'REFERENCE_MAX_DELAY_MS', 300_000),
    },
  };
}
