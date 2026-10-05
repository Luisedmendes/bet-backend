import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', fieldName: 'provider_id' })
  providerId!: string;

  @Property({ type: 'string', fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ type: 'string', fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', fieldName: 'round_id' })
  roundId!: string;

  @Property({ type: 'string', fieldName: 'game_id' })
  gameId!: string;

  @Property({ type: 'string' })
  kind!: string;

  @Property({ type: new DecimalType('string'), precision: 19, scale: 2 })
  amount!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  @Property({ type: 'string', fieldName: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId!: string | null;

  @Property({ type: 'uuid', fieldName: 'reference_transaction_id', nullable: true })
  referenceTransactionId!: string | null;

  @Property({ type: 'string' })
  status!: string;

  @Property({ type: 'string', fieldName: 'failure_code', nullable: true })
  failureCode!: string | null;

  @Property({
    type: new DecimalType('string'),
    precision: 19,
    scale: 2,
    fieldName: 'result_balance',
    nullable: true,
  })
  resultBalance!: string | null;

  @Property({ type: 'integer', fieldName: 'reference_attempts' })
  referenceAttempts!: number;

  @Property({
    type: 'datetime',
    columnType: 'timestamptz',
    fieldName: 'next_reference_attempt_at',
    nullable: true,
  })
  nextReferenceAttemptAt!: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'updated_at' })
  updatedAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
