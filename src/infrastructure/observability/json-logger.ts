import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@nestjs/common';
import type { AppLogger, LogFields } from '../../application/ports/observability.js';

const context = new AsyncLocalStorage<LogFields>();

/** Executa `fn` com campos de contexto (correlationId, messageId…) anexados a todo log. */
export function runWithLogContext<T>(fields: LogFields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

export function currentLogContext(): LogFields {
  return context.getStore() ?? {};
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logs estruturados: uma linha JSON por evento. Só campos explícitos — nunca
 * o payload financeiro completo (valores e saldos não entram nos logs).
 */
export class JsonLogger implements AppLogger, LoggerService {
  constructor(private readonly base: LogFields = {}) {}

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields | string): void {
    this.write('error', message, typeof fields === 'string' ? { stack: fields } : fields);
  }

  // ---- LoggerService (NestJS)
  log(message: unknown, contextName?: string): void {
    this.write('info', String(message), contextName ? { context: contextName } : undefined);
  }

  debug(message: unknown, contextName?: string): void {
    if (process.env.LOG_LEVEL === 'debug') {
      this.write('debug', String(message), contextName ? { context: contextName } : undefined);
    }
  }

  verbose(message: unknown, contextName?: string): void {
    this.debug(message, contextName);
  }

  private write(level: Level, message: string, fields?: LogFields): void {
    const line = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...this.base,
      ...currentLogContext(),
      ...stripUndefined(fields),
    };
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  }
}

function stripUndefined(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}
