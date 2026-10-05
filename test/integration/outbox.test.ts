import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppLogger, AppMetrics } from '../../src/application/ports/observability.js';
import { systemClock } from '../../src/application/ports/observability.js';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import { type EventPublisher, PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox.use-case.js';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import type { AppEnv } from '../../src/infrastructure/config/env.js';
import { QueueUrls } from '../../src/infrastructure/messaging/sqs.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.js';
import { TOKENS } from '../../src/interface/http/tokens.js';
import {
  createTestQueues,
  drainQueue,
  ensureTestDatabase,
  sql,
  sqsClient,
  startApp,
  testEnv,
  uuid,
  wager,
} from '../support/harness.js';

const quiet: AppLogger = { info() {}, warn() {}, error() {} };

describe('transactional outbox (real LocalStack + PostgreSQL)', () => {
  let app: INestApplication;
  let env: AppEnv;
  let queues: { wager: string; dlq: string; events: string };

  beforeAll(async () => {
    await ensureTestDatabase();
    env = testEnv({ suffix: 'outbox' });
    queues = await createTestQueues(env);
    app = await startApp(env);
    // Publica o que outras suítes deixaram, para começar do zero.
    await drainOutbox(realPublisher());
    await drainQueue(queues.events, 3);
  });

  afterAll(async () => {
    await app.close();
  });

  function realPublisher(): SqsEventPublisher {
    const client = sqsClient();
    return new SqsEventPublisher(client, new QueueUrls(client), env.sqs.eventsQueueName);
  }

  function publisherUseCase(publisher: EventPublisher): PublishOutboxUseCase {
    return new PublishOutboxUseCase(
      app.get<UnitOfWork>(TOKENS.unitOfWork),
      publisher,
      systemClock,
      quiet,
      app.get<AppMetrics>(TOKENS.metrics),
    );
  }

  async function drainOutbox(publisher: EventPublisher): Promise<void> {
    const useCase = publisherUseCase(publisher);
    while ((await useCase.runOnce(100)) > 0) {
      // continua até esvaziar
    }
  }

  async function generateEvents(count: number): Promise<string> {
    const http = request(app.getHttpServer());
    const wallet = (
      await http.post('/wallets').send({ playerId: uuid(), initialBalance: { amount: '1000.00', currency: 'BRL' } }).expect(201)
    ).body;
    for (let i = 0; i < count; i++) {
      const ext = `bet-${uuid()}`;
      await http.post('/wagering/transactions').set('Idempotency-Key', ext).send(wager(wallet, ext, 'BET', '1.00')).expect(201);
    }
    return wallet.id;
  }

  async function outboxIds(walletId: string): Promise<{ id: string; published_at: Date | null }[]> {
    const db = await sql();
    const { rows } = await db.query('SELECT id, published_at FROM outbox_messages WHERE aggregate_id = $1', [walletId]);
    await db.end();
    return rows;
  }

  it('two concurrent publishers publish every event exactly once (SKIP LOCKED)', async () => {
    const walletId = await generateEvents(15); // 2 eventos por BET + 2 da abertura = 32
    const expected = (await outboxIds(walletId)).map((r) => r.id).sort();

    const published: string[] = [];
    const tracking = (): EventPublisher => {
      const real = realPublisher();
      return {
        async publish(messages: OutboxMessage[]) {
          const accepted = await real.publish(messages);
          published.push(...messages.filter((m) => accepted.has(m.id)).map((m) => m.id));
          return accepted;
        },
      };
    };
    const a = publisherUseCase(tracking());
    const b = publisherUseCase(tracking());
    await Promise.all([
      (async () => { while ((await a.runOnce(5)) > 0); })(),
      (async () => { while ((await b.runOnce(5)) > 0); })(),
    ]);

    const mine = published.filter((id) => expected.includes(id));
    expect(mine.sort()).toEqual(expected);
    expect(new Set(mine).size).toBe(mine.length);
    expect((await outboxIds(walletId)).every((r) => r.published_at !== null)).toBe(true);

    const events = (await drainQueue(queues.events, 6)).map((b) => JSON.parse(b) as { eventId: string; aggregateId: string });
    const fromWallet = events.filter((e) => e.aggregateId === walletId).map((e) => e.eventId).sort();
    expect(fromWallet).toEqual(expected);
  }, 30_000);

  it('process dies after publishing and before committing: another instance republishes, nothing is lost', async () => {
    const walletId = await generateEvents(2);
    const expected = (await outboxIds(walletId)).map((r) => r.id).sort();

    // Instância 1 publica no SQS e "morre" antes do COMMIT que marcaria published_at.
    const crashing: EventPublisher = {
      async publish(messages) {
        await realPublisher().publish(messages);
        throw new Error('killed before commit');
      },
    };
    await publisherUseCase(crashing).runOnce(100);
    // O publish lançou → runOnce agenda retry (attempts=1) em vez de marcar publicado.
    const afterCrash = await outboxIds(walletId);
    expect(afterCrash.every((r) => r.published_at === null)).toBe(true);

    // Instância 2 assume quando o backoff vence.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await drainOutbox(realPublisher());
    expect((await outboxIds(walletId)).every((r) => r.published_at !== null)).toBe(true);

    // Duplicatas são seguras: o consumidor deduplica por eventId (o SQS FIFO também, em 5 min).
    const events = (await drainQueue(queues.events, 6)).map((b) => JSON.parse(b) as { eventId: string; aggregateId: string });
    const ids = new Set(events.filter((e) => e.aggregateId === walletId).map((e) => e.eventId));
    expect([...ids].sort()).toEqual(expected);
  }, 30_000);

  it('schedules a retry with backoff when the broker is unavailable', async () => {
    const walletId = await generateEvents(1);
    const down: EventPublisher = {
      async publish() {
        throw new Error('SQS unavailable');
      },
    };
    await publisherUseCase(down).runOnce(100);

    const db = await sql();
    const { rows } = await db.query(
      'SELECT attempts, next_attempt_at > now() AS later FROM outbox_messages WHERE aggregate_id = $1',
      [walletId],
    );
    await db.end();
    expect(rows.every((r) => r.attempts === 1 && r.later === true)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await drainOutbox(realPublisher());
  }, 30_000);

  it('event envelope carries type, version, correlation and MoneyProps', async () => {
    const walletId = await generateEvents(1);
    const db = await sql();
    const { rows } = await db.query(
      `SELECT payload FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WalletBalanceChanged' ORDER BY occurred_at DESC LIMIT 1`,
      [walletId],
    );
    await db.end();
    const payload = rows[0].payload;
    expect(payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: walletId,
      data: { direction: 'DEBIT', money: { amount: '1.00', currency: 'BRL' }, walletVersion: 2 },
    });
    expect(typeof payload.correlationId).toBe('string');
    expect(typeof payload.occurredAt).toBe('string');
  });
});
