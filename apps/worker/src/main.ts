import { createDefaultRegistry } from '@flowforge/connectors';
import { getPrisma } from '@flowforge/db';
import { createLogger, SecretBox } from '@flowforge/shared/node';
import { loadWorkerEnv } from './env';
import { startHealthServer } from './health';
import { IsolatedVmSandbox } from './sandbox/isolated-vm-sandbox';
import { startWorkers } from './worker';

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const prisma = getPrisma();
  await prisma.$connect();

  const ff = await startWorkers({
    redisUrl: env.REDIS_URL,
    prisma,
    registry: createDefaultRegistry(),
    secretBox: SecretBox.fromConfig(env),
    sandbox: new IsolatedVmSandbox({ memoryMb: env.CODE_MEMORY_MB, timeoutMs: env.CODE_TIMEOUT_MS }),
    logger,
    hooksBaseUrl: env.HOOKS_PUBLIC_URL,
    allowPrivateHosts: env.HTTP_ALLOW_PRIVATE_HOSTS.split(',').map((s) => s.trim()).filter(Boolean),
    concurrency: { runs: env.RUN_CONCURRENCY, triggers: env.TRIGGER_CONCURRENCY, testSteps: env.TEST_STEP_CONCURRENCY },
    autoPauseAfterFailures: env.AUTO_PAUSE_AFTER_FAILURES,
  });
  const health = env.WORKER_HEALTH_PORT ? startHealthServer(env.WORKER_HEALTH_PORT, prisma, ff.workers) : null;
  logger.info({ concurrency: env.RUN_CONCURRENCY, healthPort: env.WORKER_HEALTH_PORT }, 'FlowForge worker started');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down (finishing in-flight steps)…');
    const force = setTimeout(() => process.exit(1), 30_000).unref();
    health?.close();
    await ff.close();
    await prisma.$disconnect();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
