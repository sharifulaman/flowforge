import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { ConnectorRegistry } from '@flowforge/connector-sdk';
import { createDefaultRegistry } from '@flowforge/connectors';
import { CredentialStore, type FetchLike, RunLauncher, SafeHttpClient, toConnectorLogger, TriggerManager } from '@flowforge/engine';
import { QUEUES, type RunJobData, type TriggerJobData } from '@flowforge/shared';
import { createLogger, type SecretBox } from '@flowforge/shared/node';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { SECRET_BOX } from '../config/config.module';
import { API_ENV, type ApiEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.constants';
import {
  CONNECTOR_REGISTRY,
  CREDENTIAL_STORE,
  OAUTH_FETCH,
  RUN_LAUNCHER,
  RUNS_QUEUE,
  SAFE_HTTP,
  TRIGGER_MANAGER,
  TRIGGERS_QUEUE,
} from './tokens';

@Injectable()
class RuntimeLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(RUNS_QUEUE) private readonly runs: Queue,
    @Inject(TRIGGERS_QUEUE) private readonly triggers: Queue,
    @Inject(SAFE_HTTP) private readonly http: SafeHttpClient,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.runs.close(), this.triggers.close(), this.http.close()]);
  }
}

/** Engine services shared across API modules (the worker wires the same classes). */
@Global()
@Module({
  providers: [
    { provide: CONNECTOR_REGISTRY, useFactory: () => createDefaultRegistry() },
    { provide: OAUTH_FETCH, useValue: ((input, init) => fetch(input, init)) satisfies FetchLike },
    {
      provide: CREDENTIAL_STORE,
      inject: [PrismaService, SECRET_BOX, CONNECTOR_REGISTRY, OAUTH_FETCH],
      useFactory: (prisma: PrismaService, box: SecretBox, registry: ConnectorRegistry, fetchImpl: FetchLike) =>
        new CredentialStore(prisma, box, registry, { fetchImpl }),
    },
    {
      provide: SAFE_HTTP,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) =>
        new SafeHttpClient({
          allowHosts: env.HTTP_ALLOW_PRIVATE_HOSTS.split(',').map((h) => h.trim()).filter(Boolean),
        }),
    },
    {
      provide: RUNS_QUEUE,
      inject: [REDIS],
      useFactory: (connection: Redis) => new Queue<RunJobData>(QUEUES.runs, { connection }),
    },
    {
      provide: TRIGGERS_QUEUE,
      inject: [REDIS],
      useFactory: (connection: Redis) => new Queue<TriggerJobData>(QUEUES.triggers, { connection }),
    },
    {
      provide: RUN_LAUNCHER,
      inject: [PrismaService, RUNS_QUEUE],
      useFactory: (prisma: PrismaService, queue: Queue<RunJobData>) => new RunLauncher(prisma, queue),
    },
    {
      provide: TRIGGER_MANAGER,
      inject: [PrismaService, TRIGGERS_QUEUE, CONNECTOR_REGISTRY, CREDENTIAL_STORE, SAFE_HTTP, API_ENV],
      useFactory: (
        prisma: PrismaService,
        triggersQueue: Queue<TriggerJobData>,
        registry: ConnectorRegistry,
        credentials: CredentialStore,
        http: SafeHttpClient,
        env: ApiEnv,
      ) =>
        new TriggerManager({
          prisma,
          triggersQueue,
          registry,
          credentials,
          http,
          hooksBaseUrl: env.HOOKS_PUBLIC_URL,
          logger: toConnectorLogger(
            createLogger({ name: 'triggers', level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL }),
          ),
        }),
    },
    RuntimeLifecycle,
  ],
  exports: [CONNECTOR_REGISTRY, CREDENTIAL_STORE, SAFE_HTTP, RUNS_QUEUE, TRIGGERS_QUEUE, RUN_LAUNCHER, TRIGGER_MANAGER, OAUTH_FETCH],
})
export class RuntimeModule {}
