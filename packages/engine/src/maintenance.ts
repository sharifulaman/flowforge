import type { PrismaClient } from '@flowforge/db';
import { RUN_JOB_OPTIONS, type RunJobData } from '@flowforge/shared';
import type { Queue } from 'bullmq';

/**
 * Re-enqueue runs whose job vanished (Redis flush/failover, crash between DB insert and
 * enqueue). Safe: jobId === runId, and the executor is idempotent.
 */
export async function reconcileOrphanedRuns(
  prisma: PrismaClient,
  runsQueue: Queue<RunJobData>,
  olderThanMs = 2 * 60_000,
  limit = 500,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const candidates = await prisma.run.findMany({
    where: { status: { in: ['QUEUED', 'WAITING'] }, queuedAt: { lt: cutoff } },
    select: { id: true, workspaceId: true },
    orderBy: { queuedAt: 'asc' },
    take: limit,
  });
  const requeued: string[] = [];
  for (const run of candidates) {
    const job = await runsQueue.getJob(run.id);
    if (job) {
      const state = await job.getState();
      if (state !== 'completed' && state !== 'failed') continue;
      await job.remove().catch(() => undefined);
    }
    await runsQueue.add('run', { runId: run.id, workspaceId: run.workspaceId }, { ...RUN_JOB_OPTIONS, jobId: run.id });
    requeued.push(run.id);
  }
  return requeued;
}

/** Forget polled item ids after `days` (bounded table; providers rarely resurface old items). */
export async function cleanupPollDedupe(prisma: PrismaClient, days = 30): Promise<number> {
  const { count } = await prisma.pollDedupe.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - days * 86_400_000) } } });
  return count;
}

/** True when the zap's last `n` finished runs all failed (used to auto-pause broken zaps). */
export async function hasConsecutiveFailures(prisma: PrismaClient, zapId: string, n = 10): Promise<boolean> {
  const recent = await prisma.run.findMany({
    where: { zapId, status: { in: ['SUCCEEDED', 'FAILED', 'FILTERED'] } },
    orderBy: { finishedAt: 'desc' },
    take: n,
    select: { status: true },
  });
  return recent.length === n && recent.every((r) => r.status === 'FAILED');
}
