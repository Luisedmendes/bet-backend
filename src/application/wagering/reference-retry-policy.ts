/**
 * Política de espera por referências fora de ordem (README §7.1).
 *
 * Tentativa n (1 = a chegada original) agenda a próxima para
 * baseDelay * 2^(n-1), limitado a maxDelay. Ao chegar em maxAttempts sem
 * referência, a transação é REJECTED com REFERENCE_NOT_FOUND.
 *
 * Padrão: 10 tentativas, 1s → 2s → 4s … até 5 min. Na prática ~13 minutos de
 * espera total: cobre atrasos normais de entrega e reentregas do provedor sem
 * deixar dinheiro "pendurado" por horas.
 */
export class ReferenceRetryPolicy {
  constructor(
    readonly maxAttempts = 10,
    readonly baseDelayMs = 1_000,
    readonly maxDelayMs = 5 * 60_000,
  ) {}

  /** `attempt` é o número da tentativa que está acontecendo agora (1-based). */
  isExhausted(attempt: number): boolean {
    return attempt >= this.maxAttempts;
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    const delay = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    return new Date(now.getTime() + delay);
  }
}
