import { hasConsecutiveFailures, type RunExecutor, type TriggerManager } from '@flowforge/engine';
import type { PrismaClient } from '@flowforge/db';
import type { RunJobData } from '@flowforge/shared';
import { DelayedError, type Job } from 'bullmq';
import type { Logger } from 'pino';

/** Thrown to make BullMQ retry; carries the provider's Retry-After for the backoff strategy. */
export class RetryRunError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryRunError';
  }
}

export interface RunProcessorDeps {
  executor: RunExecutor;
  prisma: PrismaClient;
  triggers: TriggerManager;
  logger: Logger;
  autoPauseAfter: number;
  shutdownSignal: AbortSignal;
}

export function createRunProcessor(d: RunProcessorDeps) {
  return async (job: Job<RunJobData>, token?: string) => {
    const { runId } = job.data;
    const log = d.logger.child({ runId, jobAttempt: job.attemptsMade + 1 });
    const outcome = await d.executor.execute(runId, {
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? 1,
      signal: d.shutdownSignal,
    });

    switch (outcome.status) {
      case 'SUSPENDED':
        log.info({ resumeAt: new Date(outcome.resumeAt).toISOString() }, 'run suspended (delay)');
        await job.moveToDelayed(outcome.resumeAt, token);
        // Tells BullMQ the job was moved on purpose (not a failure, no attempt consumed).
        throw new DelayedError();
      case 'RETRY':
        log.warn({ error: outcome.error }, 'step failed transiently; retrying');
        throw new RetryRunError(outcome.error.message, outcome.retryAfterMs);
      case 'FAILED':
        log.warn({ error: outcome.error }, 'run failed');
        await maybeAutoPause(d, runId, log);
        return outcome;
      default:
        log.info({ status: outcome.status }, 'run finished');
        return outcome;
    }
  };
}

/** A zap whose last N runs all failed is switched off (status ERROR) to stop the bleeding. */
async function maybeAutoPause(d: RunProcessorDeps, runId: string, log: Logger): Promise<void> {
  if (d.autoPauseAfter <= 0) return;
  const run = await d.prisma.run.findUnique({ where: { id: runId }, select: { zapId: true, workspaceId: true } });
  if (!run) return;
  if (!(await hasConsecutiveFailures(d.prisma, run.zapId, d.autoPauseAfter))) return;
  const { count } = await d.prisma.zap.updateMany({ where: { id: run.zapId, status: 'ACTIVE' }, data: { status: 'ERROR' } });
  if (count) {
    await d.triggers.deactivate({ id: run.zapId, workspaceId: run.workspaceId });
    log.warn({ zapId: run.zapId }, `zap auto-paused after ${d.autoPauseAfter} consecutive failures`);
  }
}
