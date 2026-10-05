import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Formato da linha da tabela `wallets` (D2). Sem regra de negócio: a classe de
 * domínio é `Wallet`, e o mapper converte uma na outra. Constraints e triggers
 * vivem na migration, que é a fonte da verdade do schema.
 */
@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  @Property({ type: new DecimalType('string'), precision: 19, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', fieldName: 'updated_at' })
  updatedAt!: Date;
}
