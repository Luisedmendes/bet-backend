/**
 * Códigos estáveis e legíveis por máquina. O provedor decide pelo código se
 * reenvia, corrige o payload ou desiste (ver docs/decisions.md).
 */
export enum FailureCode {
  /** BET maior que o saldo. Pode reenviar depois que o saldo mudar. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK de um crédito que deixaria o saldo negativo. Exige ação operacional. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Valor zero numa operação que movimenta saldo. Corrigir o payload. */
  InvalidAmount = 'INVALID_AMOUNT',
  /** Moeda da operação diferente da moeda da wallet. Corrigir o payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId não é o dono da wallet. Corrigir o payload. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** Referência não chegou dentro do limite de tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Tipo da referência não é aceito (ex.: REFUND de um WIN). */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  /** Referência de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Referência existe, mas foi REJECTED/FAILED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência já foi revertida antes. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Erro permanente inesperado ao reprocessar (status FAILED). */
  ProcessingError = 'PROCESSING_ERROR',
}
