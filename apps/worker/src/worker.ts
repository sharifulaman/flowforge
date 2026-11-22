import type { ConnectorRegistry, Sandbox } from '@flowforge/connector-sdk';
import type { PrismaClient } from '@flowforge/db';
import {
  computeBackoff,
  CredentialStore,
  RunExecutor,
  RunLauncher,
  SafeHttpClient,
  StepTester,
  toConnectorLogger,
  TriggerManager,
  TriggerRuntime,
} from '@flowforge/engine';
import { QUEUES, RUN_BACKOFF_BASE_MS, RUN_BACKOFF_TYPE, type RunJobData, type TriggerJobData } from '@flowforge/shared';
import type { SecretBox } from '@flowforge/shared/node';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { createMaintenanceProcessor } from './processors/maintenance.processor';
import { createRunProcessor, RetryRunError } from './processors/run.processor';
import { createTestStepProcessor } from './processors/test-step.processor';
import { createTriggerProcessor } from './processors/trigger.processor';

export interface WorkerOptions {
  redisUrl: string;
  prisma: PrismaClient;
  registry: ConnectorRegistry;
  secretBox: SecretBox;
  sandbox: Sandbox;
  logger: Logger;
  hooksBaseUrl: string;
  allowPrivateHosts?: string[];
  concurrency?: { runs?: number; triggers?: number; testSteps?: number };
  /** Base delay for run retries (tests use a small value). */
  backoffBaseMs?: number;
  autoPauseAfterFailures?: number;
  maintenanceEveryMs?: number;
}

export interface FlowforgeWorkers {
  workers: Worker[];
  queues: { runs: Queue<RunJobData>; triggers: Queue<TriggerJobData>; maintenance: Queue };
  executor: RunExecutor;
  close(): Promise<void>;
}

/** BullMQ needs `maxRetriesPerRequest: null` on blocking connections. */
const connect = (url: string) => new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });

export async function startWorkers(o: WorkerOptions): Promise<FlowforgeWorkers> {
  const shutdown = new AbortController();
  const connections: Redis[] = [];
  const conn = () => {
    const c = connect(o.redisUrl);
    connections.push(c);
    return c;
  };

  const runsQueue = new Queue<RunJobData>(QUEUES.runs, { connection: conn() });
  const triggersQueue = new Queue<TriggerJobData>(QUEUES.triggers, { connection: conn() });
  const maintenanceQueue = new Queue(QUEUES.maintenance, { connection: conn() });

  const http = new SafeHttpClient({ allowHosts: o.allowPrivateHosts ?? [] });
  const credentials = new CredentialStore(o.prisma, o.secretBox, o.registry);
  const connectorLogger = toConnectorLogger(o.logger.child({ component: 'connectors' }));
  const launcher = new RunLauncher(o.prisma, runsQueue);
  const triggers = new TriggerManager({
    prisma: o.prisma,
    triggersQueue,
    registry: o.registry,
    credentials,
    http,
    logger: connectorLogger,
    hooksBaseUrl: o.hooksBaseUrl,
  });
  const deps = { prisma: o.prisma, registry: o.registry, credentials, http, sandbox: o.sandbox };
  const executor = new RunExecutor(deps);
  const runtime = new TriggerRuntime({ ...deps, launcher, triggers, logger: connectorLogger });
  const tester = new StepTester(deps);
  const base = o.backoffBaseMs ?? RUN_BACKOFF_BASE_MS;

  const runsWorker = new Worker<RunJobData>(
    QUEUES.runs,
    createRunProcessor({
      executor,
      prisma: o.prisma,
      triggers,
      logger: o.logger.child({ queue: 'runs' }),
      autoPauseAfter: o.autoPauseAfterFailures ?? 10,
      shutdownSignal: shutdown.signal,
    }),
    {
      connection: conn(),
      concurrency: o.concurrency?.runs ?? 10,
      // Steps have their own timeouts; give the lock enough headroom, BullMQ renews it anyway.
      lockDuration: 60_000,
      maxStalledCount: 2,
      settings: {
        backoffStrategy: (attemptsMade: number, type?: string, err?: Error) =>
          type === RUN_BACKOFF_TYPE || type === undefined
            ? computeBackoff(attemptsMade, err instanceof RetryRunError ? err.retryAfterMs : undefined, base)
            : base,
      },
    },
  );

  // A job that failed permanently outside the executor's control (crash, DB outage on the
  // last attempt, stalled too often) must not leave its run stuck in RUNNING/WAITING.
  runsWorker.on('failed', (job: Job<RunJobData> | undefined, err: Error) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted || err instanceof RetryRunError) return;
    void executor
      .failRun(job.data.runId, { message: `Internal error: ${err.message}`.slice(0, 500), code: 'INTERNAL' })
      .catch((e) => o.logger.error({ err: e, runId: job.data.runId }, 'could not mark run failed'));
  });

  const triggersWorker = new Worker<TriggerJobData>(QUEUES.triggers, createTriggerProcessor(runtime, o.logger.child({ queue: 'triggers' })), {
    connection: conn(),
    concurrency: o.concurrency?.triggers ?? 5,
  });
  const testWorker = new Worker(QUEUES.testStep, createTestStepProcessor(tester), {
    connection: conn(),
    concurrency: o.concurrency?.testSteps ?? 4,
  });
  const maintenanceWorker = new Worker(QUEUES.maintenance, createMaintenanceProcessor(o.prisma, runsQueue, o.logger.child({ queue: 'maintenance' })), {
    connection: conn(),
    concurrency: 1,
  });
  await maintenanceQueue.upsertJobScheduler('maintenance', { every: o.maintenanceEveryMs ?? 5 * 60_000 }, { name: 'maintenance', opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } } });

  const workers = [runsWorker, triggersWorker, testWorker, maintenanceWorker];
  for (const w of workers) {
    w.on('error', (err) => o.logger.error({ err, queue: w.name }, 'worker error'));
  }
  await Promise.all(workers.map((w) => w.waitUntilReady()));

  return {
    workers,
    queues: { runs: runsQueue, triggers: triggersQueue, maintenance: maintenanceQueue },
    executor,
    async close() {
      // In-flight steps abort and are retried later (by this or another worker).
      shutdown.abort();
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled([runsQueue.close(), triggersQueue.close(), maintenanceQueue.close(), http.close()]);
      for (const c of connections) c.disconnect();
    },
  };
}
