import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '../../domain/shared/id.js';
import { runWithLogContext } from '../../infrastructure/observability/json-logger.js';

const HEADER = 'x-correlation-id';
const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Propaga X-Correlation-Id (ou gera um) para logs, eventos e resposta. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADER);
    const correlationId = incoming && SAFE.test(incoming) ? incoming : newId();
    (req as Request & { correlationId: string }).correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    runWithLogContext({ correlationId }, next);
  }
}

export function correlationIdOf(req: Request): string {
  return (req as Request & { correlationId?: string }).correlationId ?? newId();
}
