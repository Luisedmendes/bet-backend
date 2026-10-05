import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', fieldName: 'consumer_name' })
  consumerName!: string;

  @PrimaryKey({ type: 'string', fieldName: 'message_id' })
  messageId!: string;

  @Property({ type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true })
  processedAt!: Date | null;
}

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ type: 'string', fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'published_at', nullable: true })
  publishedAt!: Date | null;
}
