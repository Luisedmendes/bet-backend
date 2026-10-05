import { DomainError } from '../../domain/shared/domain-error.js';
import { FailureCode } from '../../domain/wagering/failure-code.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
import { TransientInfrastructureError } from '../errors.js';
import type { AppLogger, AppMetrics, Clock } from '../ports/observability.js';
import type { UnitOfWork } from '../ports/repositories.js';
import type { ReferenceRetryPolicy } from '../wagering/reference-retry-policy.js';
import { settleAndRecord } from '../wagering/settle-and-record.js';

/**
 * Worker agendado (README §7.1): tenta de novo as transações PENDING_REFERENCE
 * vencidas. Cada uma roda na sua própria transação, com o lock da wallet —
 * várias instâncias podem rodar o worker ao mesmo tempo sem aplicar duas vezes.
 */
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: ReferenceRetryPolicy,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  /** Retorna quantas transações foram reavaliadas. */
  async runOnce(batchSize = 50): Promise<number> {
    const due = await this.uow.run((repos) =>
      repos.transactions.findDuePendingReferences(this.clock.now(), batchSize),
    );

    let handled = 0;
    for (const { id, walletId } of due) {
      try {
        if (await this.retry(id, walletId)) handled += 1;
      } catch (error) {
        if (error instanceof TransientInfrastructureError) {
          this.logger.warn('pending reference retry hit a transient error', { transactionId: id, walletId });
          continue;
        }
        if (error instanceof DomainError) {
          await this.markFailed(id, walletId, error);
          continue;
        }
        throw error;
      }
    }
    return handled;
  }

  private async retry(transactionId: string, walletId: string): Promise<boolean> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      // Lida DEPOIS do lock: outra instância pode já ter resolvido.
      const tx = await repos.transactions.findById(transactionId);
      const now = this.clock.now();
      if (
        !wallet ||
        !tx ||
        tx.status !== WagerTransactionStatus.PendingReference ||
        (tx.nextReferenceAttemptAt !== undefined && tx.nextReferenceAttemptAt > now)
      ) {
        return false;
      }

      this.metrics.retry('pending_reference');
      const result = await settleAndRecord({
        repos,
        transaction: tx,
        wallet,
        isNew: false,
        policy: this.policy,
        ctx: { correlationId: tx.id, causationId: tx.id, at: now },
      });
      if (result.status !== WagerTransactionStatus.PendingReference) {
        this.metrics.transactionProcessed(result.status, tx.kind, 'pending_reference_worker');
      }
      this.logger.info('pending reference re-evaluated', {
        transactionId: tx.id,
        walletId,
        providerId: tx.providerId,
        status: result.status,
        failureCode: tx.failureCode,
        attempts: tx.referenceAttempts,
      });
      return true;
    });
  }

  /** Erro permanente inesperado: FAILED, terminal e auditável. */
  private async markFailed(transactionId: string, walletId: string, cause: Error): Promise<void> {
    await this.uow.run(async (repos) => {
      await repos.wallets.findByIdForUpdate(walletId);
      const tx = await repos.transactions.findById(transactionId);
      if (!tx || tx.isTerminal()) return;
      tx.fail(FailureCode.ProcessingError, this.clock.now());
      repos.transactions.update(tx);
    });
    this.logger.error('pending reference failed permanently', {
      transactionId,
      walletId,
      error: cause.message,
    });
  }
}
