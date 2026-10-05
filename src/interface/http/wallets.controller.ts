import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ValidationError } from '../../application/errors.js';
import {
  CreateWalletUseCase,
  parseCreateWalletRequest,
} from '../../application/use-cases/create-wallet.use-case.js';
import { WalletQueries } from '../../application/use-cases/wallet-queries.use-case.js';
import { isUuid } from '../../application/wagering/wager-request.js';
import { ProviderAuthGuard } from './auth.guard.js';
import { correlationIdOf } from './correlation.middleware.js';

const MAX_PAGE = 200;

function walletIdParam(walletId: string): string {
  if (!isUuid(walletId)) throw new ValidationError('walletId must be a UUID');
  return walletId.toLowerCase();
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: Request) {
    return this.createWallet.execute(parseCreateWalletRequest(body), correlationIdOf(req));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(walletIdParam(walletId));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const size = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_PAGE}`);
    }
    return this.queries.getLedger(walletIdParam(walletId), cursor || undefined, size);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string, @Req() req: Request) {
    return this.queries.reconcile(walletIdParam(walletId), correlationIdOf(req));
  }
}
