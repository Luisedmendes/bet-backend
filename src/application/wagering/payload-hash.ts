import { createHash } from 'node:crypto';
import type { WagerRequest } from './wager-request.js';

/**
 * JSON canônico: chaves ordenadas recursivamente, campos undefined omitidos,
 * sem espaços. Mesmo conteúdo → mesma string, independente da ordem de chegada.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio.
 * Ficam de fora: Idempotency-Key, messageId, occurredAt e qualquer metadado de transporte.
 */
export function wagerPayloadHash(request: WagerRequest): string {
  return sha256Hex(
    canonicalJson({
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      playerId: request.playerId,
      walletId: request.walletId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind,
      money: request.money.toJSON(),
      referenceExternalTransactionId: request.referenceExternalTransactionId,
    }),
  );
}
