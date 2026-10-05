import {
  ConnectionException,
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
  type MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ApplicationError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../application/errors.js';
import type { AppMetrics } from '../../application/ports/observability.js';
import type { Repositories, UnitOfWork } from '../../application/ports/repositories.js';
import { createRepositories } from './mikro-orm-repositories.js';

/**
 * Cada `run` = um EntityManager novo (fork) + uma transação SQL.
 * `SET LOCAL lock_timeout` evita esperar indefinidamente por uma wallet
 * quente: estourou, vira erro transitório e quem chamou pode tentar de novo.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
    private readonly metrics: AppMetrics,
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork() as unknown as EntityManager;
    try {
      return await em.transactional(async (txEm) => {
        await txEm.execute(`SET LOCAL lock_timeout = ${Math.trunc(this.lockTimeoutMs)}`);
        return work(createRepositories(txEm));
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    if (error instanceof ApplicationError) return error;

    if (error instanceof UniqueConstraintViolationException) {
      return new UniqueViolationError((error as unknown as { constraint?: string }).constraint);
    }
    if (error instanceof LockWaitTimeoutException || sqlState(error) === '55P03') {
      this.metrics.lockConflict('lock_timeout');
      return new TransientInfrastructureError('Timed out waiting for a wallet lock', 'lock_timeout');
    }
    if (error instanceof DeadlockException || sqlState(error) === '40P01') {
      this.metrics.lockConflict('deadlock');
      return new TransientInfrastructureError('Deadlock detected', 'deadlock');
    }
    if (sqlState(error) === '40001') {
      this.metrics.lockConflict('serialization');
      return new TransientInfrastructureError('Serialization failure', 'serialization');
    }
    if (isUnavailable(error)) {
      return new TransientInfrastructureError('Database unavailable', 'unavailable');
    }
    return error;
  }
}

function sqlState(error: unknown): string | undefined {
  if (error instanceof DriverException) return error.code ?? error.sqlState;
  return (error as { code?: string } | undefined)?.code;
}

/** Conexão recusada/derrubada, pool esgotado ou servidor desligando. */
function isUnavailable(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  const code = sqlState(error) ?? '';
  if (code.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(code)) return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code)) return true;
  const message = (error as Error | undefined)?.message ?? '';
  return /ECONNREFUSED|ECONNRESET|Connection terminated|connect ETIMEDOUT|timeout acquiring|Timeout acquiring/i.test(
    message,
  );
}
