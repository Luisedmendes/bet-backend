import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppLogger, AppMetrics } from '../../application/ports/observability.js';
import type { QueueUrls } from './sqs.js';
import type { HandlingDecision, WagerMessageHandler } from './wager-message-handler.js';

export interface SqsConsumerOptions {
  queueName: string;
  dlqName: string;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  /** Tempo para concluir mensagens em andamento no SIGTERM antes de devolvê-las. */
  drainTimeoutMs: number;
}

/** Backoff do retry transitório, aplicado via ChangeMessageVisibility: 2s, 4s, 8s… até 60s. */
function retryDelaySeconds(receiveCount: number): number {
  return Math.min(2 ** receiveCount, 60);
}

/**
 * Long polling na fila FIFO. Mensagens do mesmo MessageGroupId (walletId) são
 * tratadas em sequência; grupos diferentes, em paralelo. `ack` (DeleteMessage)
 * só acontece depois que o use case commitou.
 */
export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private poll: AbortController | undefined;
  private readonly inFlight = new Map<string, Message>();

  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueUrls,
    private readonly handler: WagerMessageHandler,
    private readonly options: SqsConsumerOptions,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * SIGTERM: para de buscar, espera o que está em andamento até o drainTimeout
   * e devolve a visibilidade (VisibilityTimeout=0) do que não terminou.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.poll?.abort();

    const finished = await Promise.race([
      this.loop?.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.options.drainTimeoutMs)),
    ]);
    if (!finished && this.inFlight.size > 0) {
      const queueUrl = await this.queues.get(this.options.queueName);
      await Promise.allSettled(
        [...this.inFlight.values()].map((message) =>
          this.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          ),
        ),
      );
      this.logger.warn('released in-flight messages on shutdown', { count: this.inFlight.size });
    }
  }

  /** Uma rodada de receive + tratamento. Exposto para testes determinísticos. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const queueUrl = await this.queues.get(this.options.queueName);
    const received = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );
    const messages = received.Messages ?? [];

    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }

    await Promise.all(
      [...groups.values()].map(async (groupMessages) => {
        for (const message of groupMessages) {
          await this.process(queueUrl, message);
        }
      }),
    );
    return messages.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.poll = new AbortController();
      try {
        await this.pollOnce(this.poll.signal);
      } catch (error) {
        if (!this.running) break;
        this.logger.error('sqs receive failed', { error: (error as Error).message });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async process(queueUrl: string, message: Message): Promise<void> {
    const receipt = message.ReceiptHandle!;
    this.inFlight.set(receipt, message);
    try {
      const decision = await this.handler.handle(message.Body);
      await this.apply(queueUrl, message, decision);
    } finally {
      this.inFlight.delete(receipt);
    }
  }

  private async apply(queueUrl: string, message: Message, decision: HandlingDecision): Promise<void> {
    const fields = { sqsMessageId: message.MessageId, action: decision.action };
    switch (decision.action) {
      case 'ack':
        await this.delete(queueUrl, message);
        return;
      case 'retry': {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
        this.metrics.retry('sqs_consumer');
        this.logger.warn('message will be retried', { ...fields, reason: decision.reason, receiveCount });
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: retryDelaySeconds(receiveCount),
          }),
        );
        return;
      }
      case 'dlq': {
        const dlqUrl = await this.queues.get(this.options.dlqName);
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: dlqUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: { reason: { DataType: 'String', StringValue: decision.reason } },
          }),
        );
        await this.delete(queueUrl, message);
        this.metrics.dlqMessage(decision.reason);
        this.logger.warn('message sent to DLQ', { ...fields, reason: decision.reason });
        return;
      }
    }
  }

  private async delete(queueUrl: string, message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }
}
