import { InvalidMoneyError, Money } from '../../domain/money/money.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';
import { ValidationError } from '../errors.js';

/** Pedido já validado, comum às entradas HTTP e SQS. */
export interface WagerRequest {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 128;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Valida o contrato de entrada. Reúne todos os problemas numa única ValidationError. */
export function parseWagerRequest(body: unknown, idempotencyKey: unknown): WagerRequest {
  const errors: string[] = [];
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    errors.push('body must be a JSON object');
  }

  const text = (field: string, value: unknown, max = MAX_TEXT): string => {
    if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
      errors.push(`${field} must be a non-empty string without surrounding spaces`);
      return '';
    }
    if (value.length > max) {
      errors.push(`${field} must have at most ${max} characters`);
    }
    return value;
  };
  const uuid = (field: string, value: unknown): string => {
    if (!isUuid(value)) {
      errors.push(`${field} must be a UUID`);
      return '';
    }
    return value.toLowerCase();
  };

  const key = text('Idempotency-Key', idempotencyKey, 255);
  const providerId = text('providerId', input.providerId);
  const externalTransactionId = text('externalTransactionId', input.externalTransactionId);
  const playerId = uuid('playerId', input.playerId);
  const walletId = uuid('walletId', input.walletId);
  const roundId = text('roundId', input.roundId);
  const gameId = text('gameId', input.gameId);

  let kind = WagerTransactionKind.Bet;
  if (typeof input.kind !== 'string' || !SUBMITTABLE_KINDS.has(input.kind)) {
    errors.push(`kind must be one of ${[...SUBMITTABLE_KINDS].join(', ')}`);
  } else {
    kind = input.kind as WagerTransactionKind;
  }

  let reference: string | undefined;
  if (input.referenceExternalTransactionId !== undefined && input.referenceExternalTransactionId !== null) {
    reference = text('referenceExternalTransactionId', input.referenceExternalTransactionId);
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    errors.push(`${kind} requires referenceExternalTransactionId`);
  }
  if (reference !== undefined && reference === externalTransactionId) {
    errors.push('referenceExternalTransactionId cannot be the transaction itself');
  }

  let money: Money | undefined;
  const rawMoney = input.money as Record<string, unknown> | undefined;
  if (typeof rawMoney !== 'object' || rawMoney === null) {
    errors.push('money must be an object { amount, currency }');
  } else {
    try {
      money = Money.from({ amount: rawMoney.amount as string, currency: rawMoney.currency as string });
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      errors.push(`money: ${error.message}`);
    }
  }

  if (errors.length > 0 || money === undefined) {
    throw new ValidationError('Invalid wager transaction payload', errors);
  }

  return {
    idempotencyKey: key,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId: reference,
  };
}
