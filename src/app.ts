import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { type AppEnv, loadEnv } from './infrastructure/config/env.js';
import { JsonLogger } from './infrastructure/observability/json-logger.js';

/** Monta a aplicação (usado pelo main e pelos testes de integração). */
export async function createApp(
  overrides: Partial<Omit<AppModuleOptions, 'env'>> & { env?: AppEnv } = {},
): Promise<INestApplication> {
  const env = overrides.env ?? loadEnv();
  const logger = overrides.logger ?? new JsonLogger({ instanceId: env.instanceId });
  const app = await NestFactory.create(AppModule.forRoot({ ...overrides, env, logger }), {
    logger,
    bufferLogs: false,
  });
  // SIGTERM/SIGINT → beforeApplicationShutdown (drena o consumidor) → fecha o banco.
  app.enableShutdownHooks();
  return app;
}
