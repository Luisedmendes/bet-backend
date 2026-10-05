import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { AppLogger, AppMetrics } from '../../application/ports/observability.js';
import { ProcessPendingReferencesUseCase } from '../../application/use-cases/process-pending-references.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case.js';
import { TOKENS } from '../../interface/http/tokens.js';
import type { AppEnv } from '../config/env.js';
import type { QueueUrls } from '../messaging/sqs.js';
import { SqsWagerConsumer } from '../messaging/sqs-wager-consumer.js';
import { WagerMessageHandler } from '../messaging/wager-message-handler.js';
import { PeriodicWorker } from './periodic-worker.js';

/**
 * Liga os processos de fundo conforme o ambiente. Todos são seguros com
 * várias instâncias: o consumidor deduplica pela inbox, o publisher usa
 * SKIP LOCKED e o worker de referências usa o lock da wallet.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: SqsWagerConsumer | undefined;
  private readonly workers: PeriodicWorker[] = [];

  constructor(
    @Inject(TOKENS.env) private readonly env: AppEnv,
    @Inject(TOKENS.logger) private readonly logger: AppLogger,
    @Inject(TOKENS.metrics) private readonly metrics: AppMetrics,
    @Inject(TOKENS.sqsClient) private readonly sqs: SQSClient,
    @Inject(TOKENS.queueUrls) private readonly queues: QueueUrls,
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(PublishOutboxUseCase) private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(ProcessPendingReferencesUseCase) private readonly pendingReferences: ProcessPendingReferencesUseCase,
  ) {}

  onApplicationBootstrap(): void {
    const { workers, sqs } = this.env;

    if (workers.sqsConsumer) {
      this.consumer = new SqsWagerConsumer(
        this.sqs,
        this.queues,
        new WagerMessageHandler(this.processWager, sqs.consumerName, this.logger),
        {
          queueName: sqs.wagerQueueName,
          dlqName: sqs.wagerDlqName,
          waitTimeSeconds: sqs.waitTimeSeconds,
          visibilityTimeoutSeconds: sqs.visibilityTimeoutSeconds,
          drainTimeoutMs: workers.shutdownDrainMs,
        },
        this.logger,
        this.metrics,
      );
      this.consumer.start();
    }

    if (workers.outboxPublisher) {
      this.workers.push(
        new PeriodicWorker('outbox-publisher', workers.outboxIntervalMs, () => this.publishOutbox.runOnce(), this.logger),
        new PeriodicWorker('outbox-lag', 5_000, async () => (await this.publishOutbox.reportLag(), 0), this.logger),
      );
    }

    if (workers.pendingReferences) {
      this.workers.push(
        new PeriodicWorker(
          'pending-references',
          workers.pendingReferencesIntervalMs,
          () => this.pendingReferences.runOnce(),
          this.logger,
        ),
      );
    }

    for (const worker of this.workers) worker.start();
    this.logger.info('workers started', {
      sqsConsumer: workers.sqsConsumer,
      outboxPublisher: workers.outboxPublisher,
      pendingReferences: workers.pendingReferences,
    });
  }

  /** SIGTERM: termina ou devolve as mensagens em andamento antes de fechar o banco. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('shutting down workers', { signal });
    await Promise.all([this.consumer?.stop(), ...this.workers.map((w) => w.stop())]);
  }
}
