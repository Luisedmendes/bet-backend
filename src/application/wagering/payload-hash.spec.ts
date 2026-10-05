import { describe, expect, it } from 'bun:test';
import { Money } from '../../domain/money/money.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';
import { ValidationError } from '../errors.js';
import { canonicalJson, wagerPayloadHash } from './payload-hash.js';
import { parseWagerRequest, type WagerRequest } from './wager-request.js';

const request = (overrides: Partial<WagerRequest> = {}): WagerRequest => ({
  idempotencyKey: 'provider-a:tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  referenceExternalTransactionId: undefined,
  ...overrides,
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, b: 'x' } })).toBe('{"a":{"b":"x","d":2},"b":1}');
  });

  it('is independent of key order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe('wagerPayloadHash (idempotency)', () => {
  it('is a 64-char hex SHA-256', () => {
    expect(wagerPayloadHash(request())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores the Idempotency-Key (transport metadata)', () => {
    expect(wagerPayloadHash(request({ idempotencyKey: 'other' }))).toBe(wagerPayloadHash(request()));
  });

  it.each([
    ['amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['round', { roundId: 'round-988' }],
    ['wallet', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['reference', { referenceExternalTransactionId: 'tx-0' }],
  ] as const)('changes when the %s changes — same key, different payload is a conflict', (_field, change) => {
    expect(wagerPayloadHash(request(change))).not.toBe(wagerPayloadHash(request()));
  });

  it('is the same for the same business payload received in a different JSON key order', () => {
    const a = parseWagerRequest(
      {
        providerId: 'provider-a',
        externalTransactionId: 'tx-1',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      'k',
    );
    const b = parseWagerRequest(
      {
        money: { currency: 'BRL', amount: '25.00' },
        kind: 'BET',
        gameId: 'fortune-chimp',
        roundId: 'round-987',
        walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        externalTransactionId: 'tx-1',
        providerId: 'provider-a',
      },
      'k',
    );
    expect(wagerPayloadHash(a)).toBe(wagerPayloadHash(b));
  });
});

describe('parseWagerRequest', () => {
  it('rejects OPENING, a missing reference and invalid money in one ValidationError', () => {
    try {
      parseWagerRequest({ kind: 'OPENING', money: { amount: '1e3', currency: 'BRL' } }, '');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details.length).toBeGreaterThan(3);
    }
  });

  it('requires a reference for REFUND', () => {
    expect(() =>
      parseWagerRequest(
        {
          providerId: 'p',
          externalTransactionId: 'e',
          playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
          walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
          roundId: 'r',
          gameId: 'g',
          kind: 'REFUND',
          money: { amount: '1.00', currency: 'BRL' },
        },
        'k',
      ),
    ).toThrow(ValidationError);
  });
});
