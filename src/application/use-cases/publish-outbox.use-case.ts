import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { AppLogger, AppMetrics, Clock } from '../ports/observability.js';
import type { UnitOfWork } from '../ports/repositories.js';

export interface EventPublisher {
  /** Publica e devolve os ids aceitos pelo broker. Os demais serão tentados de novo. */
  publish(messages: OutboxMessage[]): Promise<Set<string>>;
}

/**
 * Publicador da Transactional Outbox (README §11).
 *
 * Cada execução trava um lote com FOR UPDATE SKIP LOCKED, publica e marca
 * como publicado na mesma transação. Vários publishers pegam lotes
 * diferentes. Se o processo morrer depois de publicar e antes do commit, o
 * lote volta a ficar pendente e é publicado de novo: entrega at-least-once,
 * e o consumidor deduplica pelo eventId.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  async runOnce(batchSize = 50): Promise<number> {
    const published = await this.uow.run(async (repos) => {
      const now = this.clock.now();
      const batch = await repos.outbox.claimDue(now, batchSize);
      if (batch.length === 0) return 0;

      let accepted = new Set<string>();
      try {
        accepted = await this.publisher.publish(batch);
      } catch (error) {
        this.logger.warn('outbox publish failed, scheduling retry', {
          error: (error as Error).message,
          batch: batch.length,
        });
      }

      for (const message of batch) {
        if (accepted.has(message.id)) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(now);
          this.metrics.retry('outbox');
        }
        repos.outbox.update(message);
      }
      return accepted.size;
    });

    if (published > 0) this.metrics.outboxPublished(published);
    return published;
  }

  async reportLag(): Promise<void> {
    const lag = await this.uow.run((repos) => repos.outbox.lag(this.clock.now()));
    this.metrics.outboxLag(lag.pending, lag.oldestAgeSeconds);
  }
}
