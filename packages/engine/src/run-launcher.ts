import { Prisma, type PrismaClient, type RunSource } from '@flowforge/db';
import { RUN_JOB_OPTIONS, type RunJobData } from '@flowforge/shared';
import type { Queue } from 'bullmq';

export interface LaunchRunParams {
  workspaceId: string;
  zapId: string;
  zapVersionId: string;
  source: RunSource;
  triggerOutput: unknown;
  /** Unique per zap; a repeat returns the existing run instead of creating a new one. */
  idempotencyKey: string;
  replayOfId?: string;
  /** Pre-completed steps (replay "from failed"): the engine skips steps already SUCCEEDED. */
  seedStepRuns?: Prisma.StepRunCreateManyRunInput[];
}

export interface LaunchResult {
  runId: string;
  duplicate: boolean;
}

export const MAX_TRIGGER_OUTPUT_BYTES = 512 * 1024;

export class RunLauncher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly runsQueue: Queue<RunJobData>,
  ) {}

  async launch(p: LaunchRunParams): Promise<LaunchResult> {
    const output = p.triggerOutput ?? {};
    if (JSON.stringify(output).length > MAX_TRIGGER_OUTPUT_BYTES) {
      throw new RangeError(`Trigger payload exceeds ${MAX_TRIGGER_OUTPUT_BYTES / 1024} KB`);
    }

    let runId: string;
    try {
      const run = await this.prisma.run.create({
        data: {
          workspaceId: p.workspaceId,
          zapId: p.zapId,
          zapVersionId: p.zapVersionId,
          source: p.source,
          idempotencyKey: p.idempotencyKey.slice(0, 255),
          triggerOutput: output as Prisma.InputJsonValue,
          replayOfId: p.replayOfId,
          steps: p.seedStepRuns?.length ? { createMany: { data: p.seedStepRuns } } : undefined,
        },
        select: { id: true },
      });
      runId = run.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.run.findUnique({
          where: { zapId_idempotencyKey: { zapId: p.zapId, idempotencyKey: p.idempotencyKey.slice(0, 255) } },
          select: { id: true },
        });
        if (existing) return { runId: existing.id, duplicate: true };
      }
      throw err;
    }

    try {
      await this.runsQueue.add('run', { runId, workspaceId: p.workspaceId }, { ...RUN_JOB_OPTIONS, jobId: runId });
    } catch (err) {
      await this.prisma.run.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: { message: 'Could not enqueue run (queue unavailable)', code: 'ENQUEUE_FAILED' },
        },
      });
      throw err;
    }
    return { runId, duplicate: false };
  }
}
