import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors.js';
import type { AppLogger } from '../../application/ports/observability.js';

/**
 * Mapeamento único de erros → HTTP, igual em todos os endpoints:
 *   400 payload inválido            409 conflito (idempotência, duplicidade)
 *   404 recurso inexistente         503 falha transitória (Retry-After)
 *   500 erro inesperado
 * Rejeição de negócio (422) e aceite pendente (202) não são exceções: vêm do
 * resultado do use case (ver WageringController).
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.map(error);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.status(status).json(body);
  }

  private map(error: unknown): {
    status: number;
    body: { error: { code: string; message: string; details?: string[] } };
    headers: Record<string, string>;
  } {
    const body = (code: string, message: string, details?: string[]) => ({
      error: { code, message, ...(details ? { details } : {}) },
    });

    if (error instanceof ValidationError) {
      return { status: 400, body: body(error.code, error.message, error.details), headers: {} };
    }
    if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
      return { status: 404, body: body(error.code, error.message), headers: {} };
    }
    if (
      error instanceof IdempotencyConflictError ||
      error instanceof ExternalTransactionConflictError ||
      error instanceof WalletAlreadyExistsError
    ) {
      return { status: 409, body: body(error.code, error.message), headers: {} };
    }
    if (error instanceof TransientInfrastructureError) {
      return { status: 503, body: body(error.code, error.message), headers: { 'Retry-After': '1' } };
    }
    if (error instanceof ApplicationError) {
      this.logger.error('unmapped application error', { code: error.code, error: error.message });
      return { status: 500, body: body('INTERNAL_ERROR', 'Internal error'), headers: {} };
    }
    if (error instanceof HttpException) {
      // Ex.: JSON malformado (body-parser) ou rota inexistente.
      const status = error.getStatus();
      const code = status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : 'VALIDATION_ERROR';
      return { status, body: body(code, error.message), headers: {} };
    }

    this.logger.error('unexpected error', { error: (error as Error)?.message, stack: (error as Error)?.stack });
    return { status: 500, body: body('INTERNAL_ERROR', 'Internal error'), headers: {} };
  }
}
