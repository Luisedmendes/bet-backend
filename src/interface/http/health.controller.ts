import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AppEnv } from '../../infrastructure/config/env.js';
import type { QueueUrls } from '../../infrastructure/messaging/sqs.js';
import type { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.js';
import { TOKENS } from './tokens.js';

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
  ]);
}

/** Endpoints abertos: sem guard de autenticação (README §2). */
@Controller()
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(TOKENS.sqsClient) private readonly sqs: SQSClient,
    @Inject(TOKENS.queueUrls) private readonly queues: QueueUrls,
    @Inject(TOKENS.env) private readonly env: AppEnv,
    @Inject(TOKENS.metrics) private readonly metrics: PrometheusMetrics,
  ) {}

  /** Processo vivo: não depende de nada externo. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Pronto para tráfego: PostgreSQL e SQS alcançáveis. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, sqs] = await Promise.all([
      withTimeout(this.orm.em.fork().getConnection().execute('SELECT 1'))
        .then(() => 'ok' as const)
        .catch(() => 'unavailable' as const),
      withTimeout(
        this.queues.get(this.env.sqs.wagerQueueName).then((url) =>
          this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] })),
        ),
      )
        .then(() => 'ok' as const)
        .catch(() => 'unavailable' as const),
    ]);
    const ok = database === 'ok' && sqs === 'ok';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { database, sqs } };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metricsText() {
    return this.metrics.registry.metrics();
  }
}
