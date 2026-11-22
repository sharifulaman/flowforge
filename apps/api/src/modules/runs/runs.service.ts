import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, Run, StepRun } from '@flowforge/db';
import type { RunLauncher } from '@flowforge/engine';
import {
  type ListRunsQuery,
  type Paginated,
  type ReplayRunInput,
  type RunDetailDto,
  type RunError,
  type RunJobData,
  type RunSummaryDto,
  type StepRunDto,
  TERMINAL_RUN_STATUSES,
  type ZapDefinition,
} from '@flowforge/shared';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../../common/api-exception';
import { iso, paginate } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';
import { RUN_LAUNCHER, RUNS_QUEUE } from '../../runtime/tokens';

type RunWithZap = Run & { zap: { name: string } };

function toSummary(r: RunWithZap): RunSummaryDto {
  return {
    id: r.id,
    zapId: r.zapId,
    zapName: r.zap.name,
    status: r.status,
    source: r.source,
    error: (r.error as RunError | null) ?? null,
    attempts: r.attempts,
    replayOfId: r.replayOfId,
    queuedAt: iso(r.queuedAt)!,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs: r.durationMs,
  };
}

function toStepRun(s: StepRun): StepRunDto {
  return {
    id: s.id,
    stepKey: s.stepKey,
    position: s.position,
    appKey: s.appKey,
    operationKey: s.operationKey,
    status: s.status,
    input: s.input ?? null,
    output: s.output ?? null,
    error: (s.error as RunError | null) ?? null,
    attempts: s.attempts,
    logs: s.logs ?? null,
    startedAt: iso(s.startedAt),
    finishedAt: iso(s.finishedAt),
    durationMs: s.durationMs,
  };
}

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUN_LAUNCHER) private readonly launcher: RunLauncher,
    @Inject(RUNS_QUEUE) private readonly queue: Queue<RunJobData>,
  ) {}

  async list(workspaceId: string, q: ListRunsQuery): Promise<Paginated<RunSummaryDto>> {
    const where: Prisma.RunWhereInput = {
      workspaceId,
      ...(q.zapId ? { zapId: q.zapId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.from || q.to ? { queuedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const rows = await this.prisma.run.findMany({
      where,
      include: { zap: { select: { name: true } } },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = paginate(rows, q.limit);
    return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
  }

  async detail(workspaceId: string, runId: string): Promise<RunDetailDto> {
    const run = await this.prisma.run.findFirst({
      where: { id: runId, workspaceId },
      include: { zap: { select: { name: true } }, zapVersion: { select: { version: true } }, steps: { orderBy: { position: 'asc' } } },
    });
    if (!run) throw ApiException.notFound('Run');
    return { ...toSummary(run), zapVersion: run.zapVersion.version, triggerOutput: run.triggerOutput, steps: run.steps.map(toStepRun) };
  }

  /**
   * Replay against the same zap version (deterministic).
   *  - full: re-run every step with the original trigger data.
   *  - from_failed: copy outputs of steps that succeeded; the engine resumes at the failed step.
   */
  async replay(workspaceId: string, runId: string, input: ReplayRunInput): Promise<{ runId: string }> {
    const run = await this.prisma.run.findFirst({ where: { id: runId, workspaceId }, include: { steps: true, zap: { select: { deletedAt: true } } } });
    if (!run) throw ApiException.notFound('Run');
    if (run.zap.deletedAt) throw ApiException.badRequest('The Zap for this run was deleted');
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) throw ApiException.conflict('Run is still in progress');
    if (input.mode === 'from_failed' && run.status !== 'FAILED') {
      throw ApiException.badRequest('Only failed runs can be replayed from the failed step; use mode "full"');
    }

    let seed: Prisma.StepRunCreateManyRunInput[] = [];
    if (input.mode === 'from_failed') {
      const version = await this.prisma.zapVersion.findUniqueOrThrow({ where: { id: run.zapVersionId } });
      const order = (version.definition as unknown as ZapDefinition).steps.map((s) => s.key);
      const byKey = new Map(run.steps.map((s) => [s.stepKey, s]));
      // Seed the prefix of consecutive successes (stop at the first non-success).
      for (const key of order) {
        const s = byKey.get(key);
        if (!s || s.status !== 'SUCCEEDED') break;
        seed.push({
          workspaceId,
          stepKey: s.stepKey,
          position: s.position,
          appKey: s.appKey,
          operationKey: s.operationKey,
          status: 'SUCCEEDED',
          input: (s.input ?? undefined) as Prisma.InputJsonValue | undefined,
          output: (s.output ?? undefined) as Prisma.InputJsonValue | undefined,
          logs: (s.logs ?? undefined) as Prisma.InputJsonValue | undefined,
          attempts: s.attempts,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          durationMs: s.durationMs,
        });
      }
    }
    if (input.mode === 'full') seed = [];

    return this.launcher.launch({
      workspaceId,
      zapId: run.zapId,
      zapVersionId: run.zapVersionId,
      source: 'REPLAY',
      triggerOutput: run.triggerOutput,
      idempotencyKey: `replay:${run.id}:${randomUUID()}`,
      replayOfId: run.id,
      seedStepRuns: seed,
    });
  }

  /**
   * Cancel a queued/waiting/running run. Queued and delayed jobs are removed; a running job
   * notices the CANCELED status between steps (worker, phase c).
   */
  async cancel(workspaceId: string, runId: string): Promise<RunSummaryDto> {
    const { count } = await this.prisma.run.updateMany({
      where: { id: runId, workspaceId, status: { in: ['QUEUED', 'WAITING', 'RUNNING'] } },
      data: { status: 'CANCELED', finishedAt: new Date() },
    });
    const run = await this.prisma.run.findFirst({ where: { id: runId, workspaceId }, include: { zap: { select: { name: true } } } });
    if (!run) throw ApiException.notFound('Run');
    if (count === 0) throw ApiException.conflict(`Run already ${run.status.toLowerCase()}`);

    const job = await this.queue.getJob(runId);
    if (job && !(await job.isActive())) await job.remove().catch(() => undefined);
    return toSummary(run);
  }
}
