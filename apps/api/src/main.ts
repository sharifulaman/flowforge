import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { configureApp, createAdapter, createApiLogger, NEST_APP_OPTIONS } from './app.factory';
import { AppModule } from './app.module';
import { PinoNestLogger } from './common/nest-logger';
import { loadApiEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadApiEnv();
  const logger = createApiLogger(env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env),
    createAdapter(env, logger),
    { ...NEST_APP_OPTIONS, logger: new PinoNestLogger(logger), bufferLogs: true },
  );
  await configureApp(app, env);
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info({ port: env.API_PORT }, `FlowForge API listening on http://localhost:${env.API_PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
