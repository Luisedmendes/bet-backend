import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { type Clock, systemClock } from './application/ports/observability.js';
import type { UnitOfWork } from './application/ports/repositories.js';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case.js';
import { ProcessPendingReferencesUseCase } from './application/use-cases/process-pending-references.use-case.js';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case.js';
import { PublishOutboxUseCase } from './application/use-cases/publish-outbox.use-case.js';
import { WalletQueries } from './application/use-cases/wallet-queries.use-case.js';
import { ReferenceRetryPolicy } from './application/wagering/reference-retry-policy.js';
import type { AppEnv } from './infrastructure/config/env.js';
import { createSqsClient, QueueUrls } from './infrastructure/messaging/sqs.js';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher.js';
import { JsonLogger } from './infrastructure/observability/json-logger.js';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics.js';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work.js';
import { WorkersService } from './infrastructure/workers/workers.service.js';
import { createMikroOrmConfig } from './mikro-orm.config.js';
import { ProviderAuthGuard } from './interface/http/auth.guard.js';
import { CorrelationMiddleware } from './interface/http/correlation.middleware.js';
import { HttpErrorFilter } from './interface/http/error-mapping.js';
import { HealthController } from './interface/http/health.controller.js';
import { TOKENS } from './interface/http/tokens.js';
import { WageringController } from './interface/http/wagering.controller.js';
import { WalletsController } from './interface/http/wallets.controller.js';

export interface AppModuleOptions {
  env: AppEnv;
  logger: JsonLogger;
  metrics?: PrometheusMetrics;
  clock?: Clock;
}

/**
 * Composição: aqui, e só aqui, as portas da aplicação recebem as
 * implementações de infraestrutura. Use cases são classes puras criadas
 * por factory — não dependem do NestJS.
 */
@Module({})
export class AppModule implements NestModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { env, logger } = options;
    const metrics = options.metrics ?? new PrometheusMetrics();
    const clock = options.clock ?? systemClock;
    const policy = new ReferenceRetryPolicy(
      env.references.maxAttempts,
      env.references.baseDelayMs,
      env.references.maxDelayMs,
    );

    return {
      module: AppModule,
      imports: [
        MikroOrmModule.forRootAsync({
          driver: PostgreSqlDriver,
          useFactory: () => ({ ...createMikroOrmConfig(env), registerRequestContext: false }),
        }),
      ],
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: TOKENS.env, useValue: env },
        { provide: TOKENS.logger, useValue: logger },
        { provide: TOKENS.metrics, useValue: metrics },
        { provide: TOKENS.clock, useValue: clock },
        { provide: TOKENS.referencePolicy, useValue: policy },
        { provide: TOKENS.sqsClient, useFactory: () => createSqsClient(env) },
        {
          provide: TOKENS.queueUrls,
          inject: [TOKENS.sqsClient],
          useFactory: (client: SQSClient) => new QueueUrls(client),
        },
        {
          provide: TOKENS.unitOfWork,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, env.database.lockTimeoutMs, metrics),
        },
        {
          provide: ProcessWagerTransactionUseCase,
          inject: [TOKENS.unitOfWork],
          useFactory: (uow: UnitOfWork) => new ProcessWagerTransactionUseCase(uow, policy, clock, logger, metrics),
        },
        {
          provide: CreateWalletUseCase,
          inject: [TOKENS.unitOfWork],
          useFactory: (uow: UnitOfWork) => new CreateWalletUseCase(uow, clock, logger),
        },
        {
          provide: WalletQueries,
          inject: [TOKENS.unitOfWork],
          useFactory: (uow: UnitOfWork) => new WalletQueries(uow, logger, metrics),
        },
        {
          provide: ProcessPendingReferencesUseCase,
          inject: [TOKENS.unitOfWork],
          useFactory: (uow: UnitOfWork) => new ProcessPendingReferencesUseCase(uow, policy, clock, logger, metrics),
        },
        {
          provide: PublishOutboxUseCase,
          inject: [TOKENS.unitOfWork, TOKENS.sqsClient, TOKENS.queueUrls],
          useFactory: (uow: UnitOfWork, client: SQSClient, queues: QueueUrls) =>
            new PublishOutboxUseCase(
              uow,
              new SqsEventPublisher(client, queues, env.sqs.eventsQueueName),
              clock,
              logger,
              metrics,
            ),
        },
        { provide: APP_FILTER, useFactory: () => new HttpErrorFilter(logger) },
        ProviderAuthGuard,
        WorkersService,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
