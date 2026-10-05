import type { EventContext } from '../../domain/events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { type SettleResult, settleWagerTransaction } from '../../domain/wagering/wager-settlement.js';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { Repositories } from '../ports/repositories.js';
import type { ReferenceRetryPolicy } from './reference-retry-policy.js';

export interface SettleAndRecordInput {
  repos: Repositories;
  transaction: WagerTransaction;
  /** Precisa estar travada (FOR UPDATE) pelo chamador. */
  wallet: Wallet;
  isNew: boolean;
  policy: ReferenceRetryPolicy;
  ctx: EventContext;
}

/**
 * Passo comum à primeira chegada (HTTP/SQS) e ao reprocessamento de
 * PENDING_REFERENCE: resolve a referência, aplica as regras do domínio e
 * registra transação, ledger, saldo e eventos na MESMA transação SQL.
 */
export async function settleAndRecord(input: SettleAndRecordInput): Promise<SettleResult> {
  const { repos, transaction: tx, wallet, policy, ctx } = input;
  const now = ctx.at;

  const reference =
    tx.referenceExternalTransactionId !== undefined
      ? await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
  const referenceAlreadyReversed =
    reference !== null && reference !== undefined && tx.isReversal()
      ? await repos.transactions.hasProcessedReversal(reference.id)
      : false;

  const attempt = tx.referenceAttempts + 1;
  const result = settleWagerTransaction({
    transaction: tx,
    wallet,
    reference: reference ?? undefined,
    referenceAlreadyReversed,
    at: now,
    nextReferenceAttemptAt: policy.nextAttemptAt(attempt, now),
    referenceAttemptsExhausted: policy.isExhausted(attempt),
  });

  if (input.isNew) repos.transactions.insert(tx);
  else repos.transactions.update(tx);

  const eventCtx: EventContext = { ...ctx, causationId: ctx.causationId ?? tx.id };

  if (result.entry) {
    repos.ledger.append(result.entry);
    repos.wallets.update(wallet);
    repos.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, result.entry, eventCtx)));
  }

  switch (result.status) {
    case WagerTransactionStatus.Processed:
      repos.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventCtx)));
      // Quem chegou antes e espera por esta transação é reprocessado logo.
      await repos.transactions.expediteDependents(tx.providerId, tx.externalTransactionId, now);
      break;
    case WagerTransactionStatus.Rejected:
      repos.outbox.add(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx)));
      break;
    case WagerTransactionStatus.PendingReference:
      // Publicado só na primeira vez; as tentativas seguintes não geram ruído.
      if (tx.referenceAttempts === 1) {
        repos.outbox.add(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventCtx)));
      }
      break;
  }

  return result;
}
