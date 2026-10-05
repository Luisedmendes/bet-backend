import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/use-cases/publish-outbox.use-case.js';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { QueueUrls } from './sqs.js';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica os eventos da outbox na fila FIFO de eventos.
 * - MessageGroupId = aggregateId (walletId): ordem por wallet dentro do broker;
 * - MessageDeduplicationId = eventId: o SQS descarta republicações em 5 min,
 *   e fora dessa janela o consumidor deduplica pelo eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueUrls,
    private readonly queueName: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<Set<string>> {
    const queueUrl = await this.queues.get(this.queueName);
    const accepted = new Set<string>();

    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      const result = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          })),
        }),
      );
      for (const ok of result.Successful ?? []) {
        const message = chunk[Number(ok.Id)];
        if (message) accepted.add(message.id);
      }
    }
    return accepted;
  }
}
