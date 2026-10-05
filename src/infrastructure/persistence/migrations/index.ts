import type { Constructor } from '@mikro-orm/core';
import type { Migration } from '@mikro-orm/migrations';
import { Migration20261005000000_initial_schema } from './Migration20261005000000_initial_schema.js';

/**
 * Migrations registradas explicitamente (sem glob): a mesma lista funciona
 * no `bun`, nos testes e no script de migração. Novas entram no final.
 */
export const migrationsList: Constructor<Migration>[] = [Migration20261005000000_initial_schema];
