import { cleanupPollDedupe, reconcileOrphanedRuns } from '@flowforge/engine';
import type { PrismaClient } from '@flowforge/db';
import type { RunJobData } from '@flowforge/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

export function createMaintenanceProcessor(prisma: PrismaClient, runsQueue: Queue<RunJobData>, logger: Logger) {
  return async () => {
    const requeued = await reconcileOrphanedRuns(prisma, runsQueue);
    const cleaned = await cleanupPollDedupe(prisma);
    if (requeued.length || cleaned) logger.info({ requeued: requeued.length, dedupeRemoved: cleaned }, 'maintenance');
    return { requeued: requeued.length, cleaned };
  };
}
