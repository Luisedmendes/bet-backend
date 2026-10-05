import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * `seq` (identity, gerado pelo banco) não é mapeado: só é lido nas consultas
 * de paginação, que usam SQL explícito.
 */
@Entity({ tableName: 'wallet_ledger_entries' })
export class LedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'transaction_id' })
  transactionId!: string;

  @Property({ type: 'string' })
  direction!: string;

  @Property({ type: new DecimalType('string'), precision: 19, scale: 2 })
  amount!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  @Property({ type: new DecimalType('string'), precision: 19, scale: 2, fieldName: 'balance_before' })
  balanceBefore!: string;

  @Property({ type: new DecimalType('string'), precision: 19, scale: 2, fieldName: 'balance_after' })
  balanceAfter!: string;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;
}
