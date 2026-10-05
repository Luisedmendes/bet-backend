import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ValidationError } from '../../application/errors.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { WalletQueries } from '../../application/use-cases/wallet-queries.use-case.js';
import { isUuid, parseWagerRequest } from '../../application/wagering/wager-request.js';
import type { WagerOutcome } from '../../application/wagering/wager-transaction-view.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
import { runWithLogContext } from '../../infrastructure/observability/json-logger.js';
import { ProviderAuthGuard } from './auth.guard.js';
import { correlationIdOf } from './correlation.middleware.js';

/**
 * Status do POST /wagering/transactions:
 *   201 PROCESSED (primeira vez)       200 PROCESSED (replay idempotente)
 *   202 PENDING_REFERENCE (aceito, aguardando a referência)
 *   422 REJECTED por regra de negócio (corpo traz failureCode; replay também 422)
 *   500 FAILED (erro permanente registrado)
 * Os erros (400/404/409/503) vêm do HttpErrorFilter.
 */
export function httpStatusOf(outcome: WagerOutcome): number {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return outcome.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      return 500;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerOutcome> {
    const request = parseWagerRequest(body, idempotencyKey);
    const correlationId = correlationIdOf(req);
    const outcome = await runWithLogContext(
      { correlationId, walletId: request.walletId, providerId: request.providerId },
      () => this.processWager.execute(request, { correlationId, source: 'http' }),
    );
    res.status(httpStatusOf(outcome));
    return outcome;
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(@Param('transactionId') transactionId: string) {
    if (!isUuid(transactionId)) throw new ValidationError('transactionId must be a UUID');
    return this.queries.getTransaction(transactionId.toLowerCase());
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
