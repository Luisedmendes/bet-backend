import { DecimalType } from '@mikro-orm/core';
import {
    Check,
    Entity,
    PrimaryKey,
    Property,
    Unique,
} from '@mikro-orm/decorators/legacy';

export interface WalletPersistenceState {
    id: string;
    playerId: string;
    currency: string;
    balance: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

@Entity({ tableName: 'wallets' })
@Unique({
    name: 'wallets_player_currency_unique',
    properties: ['playerId', 'currency'],
})
@Check({
    name: 'wallets_balance_non_negative',
    expression: "balance >= 0 AND balance <> 'NaN'::numeric",
})
@Check({
    name: 'wallets_version_positive',
    expression: 'version >= 1',
})
export class WalletEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property({ type: 'uuid', fieldName: 'player_id' })
    playerId!: string;

    @Property({ type: 'string', length: 3 })
    currency!: string;

    @Property({
        type: new DecimalType('string'),
        precision: 19,
        scale: 2,
    })
    balance!: string;

    @Property({ type: 'integer', default: 1 })
    version!: number;

    @Property({
        columnType: 'timestamptz',
        fieldName: 'created_at',
    })
    createdAt!: Date;

    @Property({
        columnType: 'timestamptz',
        fieldName: 'updated_at',
    })
    updatedAt!: Date;

    protected constructor() { }

    static rehydrate(state: WalletPersistenceState): WalletEntity {
        const entity = new WalletEntity();

        entity.id = state.id;
        entity.playerId = state.playerId;
        entity.currency = state.currency;
        entity.balance = state.balance;
        entity.version = state.version;
        entity.createdAt = state.createdAt;
        entity.updatedAt = state.updatedAt;

        return entity;
    }
}