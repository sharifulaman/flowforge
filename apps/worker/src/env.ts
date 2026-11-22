import { baseEnvSchema, loadEnv } from '@flowforge/shared/node';
import { z } from 'zod';

const int = (def: number, min = 1, max = 1_000) => z.coerce.number().int().min(min).max(max).default(def);

export const workerEnvSchema = baseEnvSchema.extend({
  RUN_CONCURRENCY: int(10),
  TRIGGER_CONCURRENCY: int(5),
  TEST_STEP_CONCURRENCY: int(4),
  CODE_MEMORY_MB: int(64, 8, 512),
  CODE_TIMEOUT_MS: int(5_000, 100, 60_000),
  /** Comma-separated hosts exempt from SSRF blocking (local development only). */
  HTTP_ALLOW_PRIVATE_HOSTS: z.string().optional().default(''),
  /** Pause a zap after this many consecutive failed runs (0 disables). */
  AUTO_PAUSE_AFTER_FAILURES: int(10, 0, 1_000),
  WORKER_HEALTH_PORT: int(4100, 0, 65_535),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source?: NodeJS.ProcessEnv): WorkerEnv {
  return loadEnv(workerEnvSchema, source);
}
