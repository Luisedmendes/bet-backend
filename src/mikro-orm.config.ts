import { FlushMode } from '@mikro-orm/core';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { type AppEnv, loadEnv } from './infrastructure/config/env.js';
import { LedgerEntryEntity } from './infrastructure/persistence/entities/ledger-entry.entity.js';
import {
  InboxMessageEntity,
  OutboxMessageEntity,
} from './infrastructure/persistence/entities/messaging.entity.js';
import { WagerTransactionEntity } from './infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from './infrastructure/persistence/entities/wallet.entity.js';
import { migrationsList } from './infrastructure/persistence/migrations/index.js';

export function createMikroOrmConfig(env: AppEnv = loadEnv()) {
  return defineConfig({
    metadataProvider: ReflectMetadataProvider,
    host: env.database.host,
    port: env.database.port,
    user: env.database.user,
    password: env.database.password,
    dbName: env.database.name,
    pool: { min: 0, max: env.database.poolMax },
    // Lista explícita: discovery por pasta é frágil entre bun/ts/dist.
    entities: [WalletEntity, WagerTransactionEntity, LedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    // Escritas só vão ao banco no COMMIT, de uma vez (Unit of Work explícita).
    flushMode: FlushMode.COMMIT,
    forceUtcTimezone: true,
    // Todo trabalho roda num fork explícito (UnitOfWork.run).
    allowGlobalContext: false,
    // Schema é das migrations, nunca sincronizado pelo ORM.
    ensureDatabase: false,
  });
}

export default createMikroOrmConfig();
