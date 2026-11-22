import { Prisma, type PrismaClient, type StepRun } from '@flowforge/db';
import { type RunError, type StepDefinition, type TemplateScope, TERMINAL_RUN_STATUSES, type ZapDefinition } from '@flowforge/shared';
import type { StepLog, StepResult, StepRunnerDeps } from './step-runner';
import { runActionStep } from './step-runner';

export interface ExecutorDeps extends StepRunnerDeps {
  prisma: PrismaClient;
  now?: () => number;
}

export interface ExecuteOptions {
  /** 1-based attempt number of this job execution. */
  attempt: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

export type RunOutcome =
  | { status: 'SUCCEEDED' }
  | { status: 'FAILED'; error: RunError }
  | { status: 'FILTERED'; reason: string; stepKey: string }
  | { status: 'CANCELED' }
  | { status: 'NOT_FOUND' }
  /** Already finished (duplicate delivery). */
  | { status: 'ALREADY_DONE' }
  /** Delay step: re-deliver the job at `resumeAt` (epoch ms). */
  | { status: 'SUSPENDED'; resumeAt: number }
  /** Transient failure with attempts left: the job should be retried with backoff. */
  | { status: 'RETRY'; error: RunError; retryAfterMs?: number };

const json = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const MAX_STORED_INPUT_BYTES = 256 * 1024;

/** Inputs can be large (they embed earlier outputs); keep history rows bounded. */
function storableInput(input: unknown): unknown {
  const s = JSON.stringify(input ?? null);
  return s.length > MAX_STORED_INPUT_BYTES ? { _truncated: true, preview: s.slice(0, 4_096) } : input;
}

interface SuspendMarker {
  __suspendedUntil: string;
}
const isSuspendMarker = (v: unknown): v is SuspendMarker =>
  !!v && typeof v === 'object' && typeof (v as SuspendMarker).__suspendedUntil === 'string';

/**
 * Executes a run step by step. Safe to call repeatedly for the same run (retries, stalled
 * jobs, delayed resumes): completed steps are checkpointed in StepRun and skipped.
 */
export class RunExecutor {
  private readonly now: () => number;

  constructor(private readonly d: ExecutorDeps) {
    this.now = d.now ?? Date.now;
  }

  async execute(runId: string, opts: ExecuteOptions): Promise<RunOutcome> {
    const run = await this.d.prisma.run.findUnique({
      where: { id: runId },
      include: { zapVersion: { select: { definition: true } }, steps: true },
    });
    if (!run) return { status: 'NOT_FOUND' };
    if (run.status === 'CANCELED') return { status: 'CANCELED' };
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return { status: 'ALREADY_DONE' };

    const def = run.zapVersion.definition as unknown as ZapDefinition;
    const startedAt = run.startedAt ?? new Date(this.now());
    // Guarded update: never resurrect a run canceled in the meantime.
    const claimed = await this.d.prisma.run.updateMany({
      where: { id: runId, status: { in: ['QUEUED', 'WAITING', 'RUNNING'] } },
      data: { status: 'RUNNING', startedAt, attempts: opts.attempt },
    });
    if (claimed.count === 0) return { status: 'CANCELED' };

    const scope: TemplateScope = { trigger: run.triggerOutput };
    const byKey = new Map<string, StepRun>(run.steps.map((s) => [s.stepKey, s]));

    for (const [index, step] of def.steps.entries()) {
      const position = index + 1;
      const existing = byKey.get(step.key);

      if (existing?.status === 'SUCCEEDED') {
        scope[step.key] = existing.output;
        continue;
      }

      // Resuming after a Delay step.
      if (existing?.status === 'RUNNING' && isSuspendMarker(existing.output)) {
        const until = Date.parse(existing.output.__suspendedUntil);
        if (this.now() < until - 1_000) return this.suspend(runId, until); // woke early
        const output = { delayedUntil: existing.output.__suspendedUntil, resumedAt: new Date(this.now()).toISOString() };
        await this.saveStep(run.workspaceId, runId, step, position, { status: 'SUCCEEDED', output, finishedAt: new Date(this.now()), durationMs: this.now() - (existing.startedAt?.getTime() ?? this.now()) });
        scope[step.key] = output;
        continue;
      }

      // Cancellation is checked between steps.
      if (await this.isCanceled(runId)) return { status: 'CANCELED' };

      const stepStarted = new Date(this.now());
      await this.saveStep(run.workspaceId, runId, step, position, {
        status: 'RUNNING',
        startedAt: stepStarted,
        attemptsIncrement: true,
        error: null,
      });

      const result: StepResult = await runActionStep(this.d, {
        workspaceId: run.workspaceId,
        runId,
        step,
        scope,
        signal: opts.signal,
      });
      const finishedAt = new Date(this.now());
      const base = { input: storableInput(result.input), logs: result.logs, finishedAt, durationMs: result.durationMs };

      if (result.ok) {
        await this.saveStep(run.workspaceId, runId, step, position, { ...base, status: 'SUCCEEDED', output: result.output, error: null });
        scope[step.key] = result.output;
        continue;
      }

      const f = result.failure;
      switch (f.kind) {
        case 'stop': {
          await this.saveStep(run.workspaceId, runId, step, position, { ...base, status: 'FILTERED', output: { stopped: true, reason: f.reason } });
          await this.finish(runId, startedAt, 'FILTERED', { message: f.reason, code: 'FILTERED', stepKey: step.key });
          return { status: 'FILTERED', reason: f.reason, stepKey: step.key };
        }
        case 'suspend': {
          const until = f.resumeAt.getTime();
          await this.saveStep(run.workspaceId, runId, step, position, {
            ...base,
            status: 'RUNNING',
            output: { __suspendedUntil: f.resumeAt.toISOString() } satisfies SuspendMarker,
            finishedAt: null,
            durationMs: null,
          });
          return this.suspend(runId, until);
        }
        case 'retry': {
          const error = { ...f.error, stepKey: step.key };
          await this.saveStep(run.workspaceId, runId, step, position, { ...base, status: 'FAILED', error, logs: result.logs });
          if (opts.attempt < opts.maxAttempts) {
            await this.d.prisma.run.updateMany({
              where: { id: runId, status: 'RUNNING' },
              data: { status: 'WAITING', error: { ...error, willRetry: true } as Prisma.InputJsonValue },
            });
            return { status: 'RETRY', error, retryAfterMs: f.retryAfterMs };
          }
          const final = { ...error, message: `${error.message} (gave up after ${opts.maxAttempts} attempts)` };
          await this.finish(runId, startedAt, 'FAILED', final);
          return { status: 'FAILED', error: final };
        }
        case 'fatal':
        case 'auth': {
          const error = { ...f.error, stepKey: step.key };
          await this.saveStep(run.workspaceId, runId, step, position, { ...base, status: 'FAILED', error });
          await this.finish(runId, startedAt, 'FAILED', error);
          return { status: 'FAILED', error };
        }
      }
    }

    await this.finish(runId, startedAt, 'SUCCEEDED', null);
    return { status: 'SUCCEEDED' };
  }

  /** Mark a run FAILED from outside the executor (e.g. worker crash on the last attempt). */
  async failRun(runId: string, error: RunError): Promise<void> {
    const run = await this.d.prisma.run.findUnique({ where: { id: runId }, select: { startedAt: true } });
    await this.finish(runId, run?.startedAt ?? new Date(this.now()), 'FAILED', error);
  }

  private async suspend(runId: string, until: number): Promise<RunOutcome> {
    await this.d.prisma.run.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { status: 'WAITING' } });
    return { status: 'SUSPENDED', resumeAt: until };
  }

  private async isCanceled(runId: string): Promise<boolean> {
    const r = await this.d.prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
    return !r || r.status === 'CANCELED';
  }

  private async finish(runId: string, startedAt: Date, status: 'SUCCEEDED' | 'FAILED' | 'FILTERED', error: RunError | null): Promise<void> {
    const finishedAt = new Date(this.now());
    // Guard: a concurrent cancel wins.
    await this.d.prisma.run.updateMany({
      where: { id: runId, status: { not: 'CANCELED' } },
      data: { status, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), error: json(error) },
    });
  }

  private async saveStep(
    workspaceId: string,
    runId: string,
    step: StepDefinition,
    position: number,
    p: {
      status: StepRun['status'];
      input?: unknown;
      output?: unknown;
      error?: RunError | null;
      logs?: StepLog[];
      startedAt?: Date;
      finishedAt?: Date | null;
      durationMs?: number | null;
      attemptsIncrement?: boolean;
    },
  ): Promise<void> {
    const data = {
      status: p.status,
      ...(p.input !== undefined ? { input: json(p.input) } : {}),
      ...(p.output !== undefined ? { output: json(p.output) } : {}),
      ...(p.error !== undefined ? { error: json(p.error) } : {}),
      ...(p.logs !== undefined ? { logs: p.logs.length ? (p.logs as unknown as Prisma.InputJsonValue) : Prisma.DbNull } : {}),
      ...(p.finishedAt !== undefined ? { finishedAt: p.finishedAt } : {}),
      ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
    };
    await this.d.prisma.stepRun.upsert({
      where: { runId_stepKey: { runId, stepKey: step.key } },
      create: {
        runId,
        workspaceId,
        stepKey: step.key,
        position,
        appKey: step.appKey,
        operationKey: step.operationKey,
        startedAt: p.startedAt ?? new Date(this.now()),
        attempts: p.attemptsIncrement ? 1 : 0,
        ...data,
      },
      update: {
        ...data,
        ...(p.attemptsIncrement ? { attempts: { increment: 1 } } : {}),
        ...(p.startedAt ? { startedAt: p.startedAt } : {}),
      },
    });
  }
}
