/**
 * Migrations contra o banco do `.env`.
 *   bun run migrate:up            aplica as pendentes
 *   bun run migrate:down          reverte a última
 *   bun run migrate:down --all    reverte todas
 *   bun run migrate:status        lista executadas / pendentes
 */
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../src/mikro-orm.config.js';

const [command = 'up', ...flags] = process.argv.slice(2);
const orm = await MikroORM.init(createMikroOrmConfig());

try {
  const migrator = orm.migrator;
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Nothing to apply');
      break;
    }
    case 'down': {
      const reverted = await migrator.down(flags.includes('--all') ? { to: 0 } : undefined);
      console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert');
      break;
    }
    case 'status': {
      console.log('Executed:', (await migrator.getExecuted()).map((m) => m.name));
      console.log('Pending :', (await migrator.getPending()).map((m) => m.name));
      break;
    }
    default:
      throw new Error(`Unknown command "${command}" (expected up | down | status)`);
  }
} finally {
  await orm.close(true);
}
