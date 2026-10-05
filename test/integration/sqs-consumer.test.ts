import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppMetrics } from '../../src/application/ports/observability.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import type { AppEnv } from '../../src/infrastructure/config/env.js';
import { QueueUrls } from '../../src/infrastructure/messaging/sqs.js';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer.js';
import { type HandlingDecision, WagerMessageHandler } from '../../src/infrastructure/messaging/wager-message-handler.js';
import { TOKENS } from '../../src/interface/http/tokens.js';
import {
  createTestQueues,
  drainQueue,
  ensureTestDatabase,
  expectLedgerConsistent,
  sendWagerMessage,
  sql,
  sqsClient,
  startApp,
  testEnv,
  uuid,
  wager,
} from '../support/harness.js';

describe('SQS consumer (real LocalStack + PostgreSQL)', () => {
  let app: INestApplication;
  let env: AppEnv;
  let queues: { wager: string; dlq: string; events: string };
  const wallets: string[] = [];

  beforeAll(async () => {
    await ensureTestDatabase();
    env = testEnv({ suffix: 'consumer', SQS_VISIBILITY_TIMEOUT_SECONDS: '2' });
    queues = await createTestQueues(env, 2);
    app = await startApp(env);
  });

  afterAll(async () => {
    await expectLedgerConsistent(wallets);
    await app.close();
  });

  async function openWallet(amount = '100.00') {
    const res = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: uuid(), initialBalance: { amount, currency: 'BRL' } })
      .expect(201);
    wallets.push(res.body.id);
    return res.body as { id: string; playerId: string };
  }

  function consumerWith(handler: { handle(body: string | undefined): Promise<HandlingDecision> }) {
    const client = sqsClient();
    return new SqsWagerConsumer(
      client,
      new QueueUrls(client),
      handler as WagerMessageHandler,
      {
        queueName: env.sqs.wagerQueueName,
        dlqName: env.sqs.wagerDlqName,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 2,
        drainTimeoutMs: 2_000,
      },
      { info() {}, warn() {}, error() {} },
      app.get<AppMetrics>(TOKENS.metrics),
    );
  }

  const realHandler = () =>
    new WagerMessageHandler(app.get(ProcessWagerTransactionUseCase), env.sqs.consumerName, {
      info() {},
      warn() {},
      error() {},
    });

  async function balanceOf(walletId: string): Promise<string> {
    const res = await request(app.getHttpServer()).get(`/wallets/${walletId}`).expect(200);
    return res.body.balance.amount;
  }

  async function pollUntilEmpty(consumer: SqsWagerConsumer, rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      const n = await consumer.pollOnce();
      if (n === 0 && i > 0) return;
    }
  }

  it('processes a message through the same use case and records it in the inbox', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uuid()}`;
    const ext = `tx-${uuid()}`;
    await sendWagerMessage(queues.wager, messageId, { ...wager(wallet, ext, 'BET', '25.00'), idempotencyKey: `provider-a:${ext}` });

    await pollUntilEmpty(consumerWith(realHandler()));

    expect(await balanceOf(wallet.id)).toBe('75.00');
    const db = await sql();
    const inbox = await db.query('SELECT processed_at FROM inbox_messages WHERE message_id = $1', [messageId]);
    await db.end();
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].processed_at).not.toBeNull();
  });

  it('redelivery of the same messageId does not duplicate the effect', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uuid()}`;
    const ext = `tx-${uuid()}`;
    const data = { ...wager(wallet, ext, 'BET', '10.00'), idempotencyKey: `provider-a:${ext}` };
    await sendWagerMessage(queues.wager, messageId, data);
    await sendWagerMessage(queues.wager, messageId, data);
    await sendWagerMessage(queues.wager, `other-${uuid()}`, data); // mesmo pedido, outro messageId → replay idempotente

    await pollUntilEmpty(consumerWith(realHandler()));

    expect(await balanceOf(wallet.id)).toBe('90.00');
  });

  it('worker dies after the commit and before the ack: redelivery is absorbed by the inbox', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uuid()}`;
    const ext = `tx-${uuid()}`;
    await sendWagerMessage(queues.wager, messageId, { ...wager(wallet, ext, 'BET', '30.00'), idempotencyKey: `provider-a:${ext}` });

    // "Crash": processa e commita, mas nunca apaga a mensagem.
    const handler = realHandler();
    let crashed = 0;
    const crashingConsumer = consumerWith({
      async handle(body) {
        await handler.handle(body);
        crashed += 1;
        throw new Error('process killed before ack');
      },
    });
    await crashingConsumer.pollOnce().catch(() => undefined);
    expect(crashed).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('70.00');

    // Visibilidade expira (2s) e outra instância recebe a mesma mensagem.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await pollUntilEmpty(consumerWith(realHandler()));

    expect(await balanceOf(wallet.id)).toBe('70.00');
    const db = await sql();
    const debits = await db.query(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [wallet.id],
    );
    await db.end();
    expect(debits.rows[0].n).toBe(1);
  });

  it('sends permanent failures (malformed / invalid payload) to the DLQ', async () => {
    const client = sqsClient();
    const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
    await client.send(
      new SendMessageCommand({ QueueUrl: queues.wager, MessageBody: '{not json', MessageGroupId: 'bad', MessageDeduplicationId: uuid() }),
    );
    await sendWagerMessage(queues.wager, `msg-${uuid()}`, { providerId: 'provider-a', kind: 'BET' });
    client.destroy();

    await pollUntilEmpty(consumerWith(realHandler()));

    const dead = await drainQueue(queues.dlq);
    expect(dead).toContain('{not json');
    expect(dead.some((body) => body.includes('"kind":"BET"'))).toBe(true);
  });

  it('retries transient failures with backoff and lets SQS redrive them to the DLQ after maxReceiveCount', async () => {
    const marker = `transient-${uuid()}`;
    await sendWagerMessage(queues.wager, marker, { marker }, marker);

    let attempts = 0;
    const consumer = consumerWith({
      async handle(body) {
        if (body?.includes(marker)) attempts += 1;
        return { action: 'retry', reason: 'unavailable' };
      },
    });

    // maxReceiveCount = 2: 1ª e 2ª entregas falham; na 3ª o SQS move para a DLQ.
    const deadline = Date.now() + 20_000;
    let dead: string[] = [];
    while (Date.now() < deadline) {
      await consumer.pollOnce();
      dead = await drainQueue(queues.dlq, 1);
      if (dead.some((b) => b.includes(marker))) break;
    }
    expect(attempts).toBe(2);
    expect(dead.some((b) => b.includes(marker))).toBe(true);
  }, 30_000);

  it('on SIGTERM finishes or releases in-flight messages', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uuid()}`;
    const ext = `tx-${uuid()}`;
    await sendWagerMessage(queues.wager, messageId, { ...wager(wallet, ext, 'BET', '5.00'), idempotencyKey: `provider-a:${ext}` });

    const handler = realHandler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = consumerWith({
      async handle(body) {
        await gate; // segura a mensagem "em andamento"
        return handler.handle(body);
      },
    });
    slow.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // drainTimeout de 2s estoura → mensagem devolvida à fila (visibility 0).
    const stopping = slow.stop();
    await stopping;
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Outra instância processa (ou encontra a inbox, se a primeira chegou a commitar).
    await pollUntilEmpty(consumerWith(realHandler()));
    expect(await balanceOf(wallet.id)).toBe('95.00');
  }, 30_000);
});
