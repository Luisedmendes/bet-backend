/** Tokens de injeção das portas (interfaces não existem em runtime). */
export const TOKENS = {
  env: Symbol('AppEnv'),
  logger: Symbol('AppLogger'),
  metrics: Symbol('AppMetrics'),
  clock: Symbol('Clock'),
  unitOfWork: Symbol('UnitOfWork'),
  sqsClient: Symbol('SQSClient'),
  queueUrls: Symbol('QueueUrls'),
  referencePolicy: Symbol('ReferenceRetryPolicy'),
} as const;
