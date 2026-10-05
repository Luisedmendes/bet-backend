import 'reflect-metadata';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { createApp } from '../../src/app.js';
import { type AppEnv, loadEnv } from '../../src/infrastructure/config/env.js';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger.js';
import { createMikroOrmConfig } from '../../src/mikro-orm.config.js';

/**
 * Testes de integração usam PostgreSQL e LocalStack REAIS (`bun run infra:up`).
 * Banco próprio (<db>_test), recriado uma vez por execução; filas próprias
 * por suíte. Cada teste usa wallets novas, então não há limpeza entre testes.
 */
const base = loadEnv();
export const TEST_DB = `${base.database.name}_test`;

export function testEnv(overrides: { suffix?: string; maxReceiveCount?: number } & Partial<Record<string, string>> = {}): AppEnv {
  const suffix = overrides.suffix ?? 'default';
  return loadEnv({
    ...process.env,
    POSTGRES_DB: TEST_DB,
    SQS_WAGER_QUEUE_NAME: `wager-transactions-${suffix}.fifo`,
    SQS_WAGER_DLQ_NAME: `wager-transactions-dlq-${suffix}.fifo`,
    SQS_EVENTS_QUEUE_NAME: `wagering-events-${suffix}.fifo`,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    WORKER_SQS_CONSUMER: 'false',
    WORKER_OUTBOX_PUBLISHER: 'false',
    WORKER_PENDING_REFERENCES: 'false',
    DB_POOL_MAX: '20',
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => /^[A-Z_]+$/.test(k))),
  });
}

let databaseReady: Promise<void> | undefined;

/** Recria o banco de teste e aplica as migrations (uma vez por processo). */
export function ensureTestDatabase(): Promise<void> {
  databaseReady ??= (async () => {
    const admin = new Client({
      host: base.database.host,
      port: base.database.port,
      user: base.database.user,
      password: base.database.password,
      database: 'postgres',
    });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    const orm = await MikroORM.init(createMikroOrmConfig(testEnv()));
    try {
      await orm.migrator.up();
    } finally {
      await orm.close(true);
    }
  })();
  return databaseReady;
}

/** Conexão SQL direta para asserções (fora da aplicação). */
export async function sql(): Promise<Client> {
  const client = new Client({
    host: base.database.host,
    port: base.database.port,
    user: base.database.user,
    password: base.database.password,
    database: TEST_DB,
  });
  await client.connect();
  return client;
}

export function sqsClient(): SQSClient {
  return new SQSClient({ region: base.sqs.region, endpoint: base.sqs.endpoint });
}

/** Cria (ou limpa) as filas da suíte: principal com redrive para a DLQ, e a de eventos. */
export async function createTestQueues(env: AppEnv, maxReceiveCount = 3): Promise<{ wager: string; dlq: string; events: string }> {
  const client = sqsClient();
  const create = async (name: string, attributes: Record<string, string>) =>
    (await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }))).QueueUrl!;

  const dlq = await create(env.sqs.wagerDlqName, { FifoQueue: 'true', ContentBasedDeduplication: 'false' });
  const dlqArn = (
    await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn!;
  const wager = await create(env.sqs.wagerQueueName, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: String(env.sqs.visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
  });
  const events = await create(env.sqs.eventsQueueName, { FifoQueue: 'true', ContentBasedDeduplication: 'false' });
  await Promise.all([wager, dlq, events].map((url) => client.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined)));
  client.destroy();
  return { wager, dlq, events };
}

export async function sendWagerMessage(
  queueUrl: string,
  messageId: string,
  data: Record<string, unknown>,
  groupId = typeof data.walletId === 'string' ? data.walletId : 'g',
): Promise<void> {
  const client = sqsClient();
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: groupId,
      MessageDeduplicationId: `${messageId}-${crypto.randomUUID()}`,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data,
      }),
    }),
  );
  client.destroy();
}

/** Drena a fila (apagando o que leu — em FIFO, mensagem em voo bloqueia o grupo) e devolve os corpos. */
export async function drainQueue(queueUrl: string, attempts = 20): Promise<string[]> {
  const client = sqsClient();
  const bodies: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const out = await client.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60 }),
    );
    const messages = out.Messages ?? [];
    bodies.push(...messages.map((m) => m.Body ?? ''));
    if (messages.length > 0) {
      await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
        }),
      );
    }
    if (messages.length === 0 && i > 0) break;
  }
  client.destroy();
  return bodies;
}

export const silentLogger = () => new JsonLogger({ test: true });

export async function startApp(env: AppEnv): Promise<INestApplication> {
  const quiet = new (class extends JsonLogger {
    override info(): void {}
    override log(): void {}
    override warn(): void {}
  })();
  const app = await createApp({ env, logger: process.env.TEST_LOGS ? silentLogger() : quiet });
  await app.init();
  return app;
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Corpo de uma transação de aposta, com defaults. */
export function wager(
  wallet: { id: string; playerId: string },
  externalTransactionId: string,
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

/**
 * Invariante final de todos os testes (README §13):
 * wallet.balance == saldo reconstruído pelo ledger, e a cadeia do ledger fecha.
 */
export async function expectLedgerConsistent(walletIds: string[]): Promise<void> {
  const db = await sql();
  try {
    const { rows } = await db.query<{ id: string; balance: string; rebuilt: string; last_after: string | null }>(
      `SELECT w.id,
              w.balance::text AS balance,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(30,2)::text AS rebuilt,
              (SELECT balance_after::text FROM wallet_ledger_entries x WHERE x.wallet_id = w.id ORDER BY seq DESC LIMIT 1) AS last_after
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ANY($1::uuid[])
        GROUP BY w.id`,
      [walletIds],
    );
    if (rows.length !== walletIds.length) throw new Error(`expected ${walletIds.length} wallets, found ${rows.length}`);
    for (const row of rows) {
      if (row.balance !== row.rebuilt || (row.last_after !== null && row.last_after !== row.balance)) {
        throw new Error(`wallet ${row.id}: balance ${row.balance}, ledger ${row.rebuilt}, last ${row.last_after}`);
      }
    }
  } finally {
    await db.end();
  }
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
