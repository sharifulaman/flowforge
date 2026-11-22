import { PrismaClient } from '@flowforge/db';
import { RunLauncher } from '@flowforge/engine';
import { QUEUES, triggerSchedulerId, type StepDefinition, type TestStepResult, type ZapDefinition } from '@flowforge/shared';
import { SecretBox } from '@flowforge/shared/node';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IsolatedVmSandbox } from '../src/sandbox/isolated-vm-sandbox';
import { type FlowforgeWorkers, startWorkers } from '../src/worker';
import { counters, pollItems, registry } from './fixtures';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
let ff: FlowforgeWorkers;
let launcher: RunLauncher;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function resetDb() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} CASCADE`);
}

async function start(opts: Partial<Parameters<typeof startWorkers>[0]> = {}) {
  ff = await startWorkers({
    redisUrl: process.env.REDIS_URL!,
    prisma,
    registry: registry(),
    secretBox: new SecretBox({ 1: Buffer.alloc(32, 9) }, 1),
    sandbox: new IsolatedVmSandbox({ timeoutMs: 1_000, memoryMb: 16 }),
    logger: pino({ level: 'silent' }),
    hooksBaseUrl: 'https://hooks.test',
    backoffBaseMs: 30,
    autoPauseAfterFailures: 3,
    maintenanceEveryMs: 60_000,
    ...opts,
  });
  launcher = new RunLauncher(prisma, ff.queues.runs);
}

const step = (key: string, operationKey: string, config: Record<string, unknown> = {}): StepDefinition => ({
  key, name: null, appKey: 'kit', operationKey, connectionId: null, config, timeoutMs: null,
});

async function zapWith(steps: StepDefinition[], trigger: Partial<StepDefinition> = {}) {
  const user = await prisma.user.create({ data: { email: `u${Math.random()}@x.test` } });
  const ws = await prisma.workspace.create({ data: { name: 'W', slug: `w${Math.random()}`, memberships: { create: { userId: user.id, role: 'OWNER' } } } });
  const zap = await prisma.zap.create({ data: { workspaceId: ws.id, name: 'Z', createdById: user.id } });
  const def: ZapDefinition = {
    schemaVersion: 1,
    trigger: { key: 'trigger', name: null, appKey: 'webhook', operationKey: 'catchHook', connectionId: null, config: {}, timeoutMs: null, ...trigger },
    steps,
  };
  const version = await prisma.zapVersion.create({ data: { zapId: zap.id, workspaceId: ws.id, version: 1, createdById: user.id, definition: def as never } });
  await prisma.zap.update({ where: { id: zap.id }, data: { status: 'ACTIVE', publishedVersionId: version.id } });
  return { ws, zap, version };
}

async function launch(z: Awaited<ReturnType<typeof zapWith>>, triggerOutput: unknown = { body: { name: 'Ada' } }) {
  const { runId } = await launcher.launch({ workspaceId: z.ws.id, zapId: z.zap.id, zapVersionId: z.version.id, source: 'WEBHOOK', triggerOutput, idempotencyKey: `k${Math.random()}` });
  return runId;
}

const finished = (runId: string, timeoutMs = 10_000) =>
  waitFor(async () => {
    const r = await prisma.run.findUnique({ where: { id: runId }, include: { steps: { orderBy: { position: 'asc' } } } });
    return r && ['SUCCEEDED', 'FAILED', 'FILTERED', 'CANCELED'].includes(r.status) ? r : null;
  }, timeoutMs, `run ${runId} to finish`);

beforeAll(async () => {
  await redis.flushdb();
});
beforeEach(async () => {
  await resetDb();
  for (const k of Object.keys(counters)) delete counters[k];
  pollItems.length = 0;
  await start();
});
afterEach(async () => {
  await ff.close();
  await redis.flushdb();
});
afterAll(async () => {
  redis.disconnect();
  await prisma.$disconnect();
});

describe('run execution through BullMQ', () => {
  it('executes a run end-to-end with data mapping', async () => {
    const z = await zapWith([step('step1', 'echo', { greeting: 'Hello {{ trigger.body.name }}' }), step('step2', 'echo', { copy: '{{ step1.greeting }}' })]);
    const run = await finished(await launch(z));
    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.map((s) => s.output)).toEqual([{ greeting: 'Hello Ada' }, { copy: 'Hello Ada' }]);
  });

  it('retries transient failures with backoff and succeeds', async () => {
    const z = await zapWith([step('step1', 'echo', { a: 1 }), step('step2', 'flaky', { times: 2, key: 'x' })]);
    const runId = await launch(z);
    const run = await finished(runId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
    expect(run.steps.map((s) => [s.stepKey, s.attempts, s.status])).toEqual([
      ['step1', 1, 'SUCCEEDED'],
      ['step2', 3, 'SUCCEEDED'],
    ]);
  });

  it('gives up after the configured attempts', async () => {
    const z = await zapWith([step('step1', 'flaky', { times: 99, key: 'y' })]);
    const run = await finished(await launch(z));
    expect(run.status).toBe('FAILED');
    expect(run.attempts).toBe(5);
    expect(run.error).toMatchObject({ stepKey: 'step1', message: expect.stringMatching(/gave up after 5 attempts/) });
  });

  it('suspends on Delay without holding a worker slot, then resumes', async () => {
    const z = await zapWith([step('step1', 'wait', { ms: 600 }), step('step2', 'echo', { after: '{{ step1.delayedUntil }}' })]);
    const runId = await launch(z);
    await waitFor(async () => (await prisma.run.findUnique({ where: { id: runId } }))?.status === 'WAITING', 5_000, 'WAITING');
    expect(await (await ff.queues.runs.getJob(runId))?.getState()).toBe('delayed');
    const run = await finished(runId);
    expect(run.status).toBe('SUCCEEDED');
    expect(counters.wait).toBe(1);
    expect(run.steps[1]!.output).toMatchObject({ after: expect.any(String) });
  });

  it('honours cancellation while a run is delayed', async () => {
    const z = await zapWith([step('step1', 'wait', { ms: 400 }), step('step2', 'echo')]);
    const runId = await launch(z);
    await waitFor(async () => (await prisma.run.findUnique({ where: { id: runId } }))?.status === 'WAITING', 5_000);
    await prisma.run.update({ where: { id: runId }, data: { status: 'CANCELED', finishedAt: new Date() } });
    await new Promise((r) => setTimeout(r, 900));
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { steps: true } });
    expect(run.status).toBe('CANCELED');
    expect(run.steps.find((s) => s.stepKey === 'step2')).toBeUndefined();
  });

  it('runs user code in the isolated-vm sandbox', async () => {
    const z = await zapWith([
      step('step1', 'code', {
        code: 'console.log("items", input.items.length); return { total: input.items.reduce((s, i) => s + i, 0) };',
        data: { items: '{{ trigger.body.items }}' },
      }),
      step('step2', 'code', { code: 'while(true){}' }),
    ]);
    const run = await finished(await launch(z, { body: { items: [1, 2, 3] } }));
    expect(run.steps[0]).toMatchObject({ status: 'SUCCEEDED', output: { total: 6 } });
    expect(run.steps[0]!.logs).toEqual([expect.objectContaining({ message: 'items 3' })]);
    expect(run.steps[1]).toMatchObject({ status: 'FAILED', error: { code: 'CODE_TIMEOUT' } });
    expect(run.status).toBe('FAILED');
  });

  it('marks the run FAILED when the job itself keeps crashing', async () => {
    const z = await zapWith([step('step1', 'echo')]);
    await prisma.zapVersion.update({ where: { id: z.version.id }, data: { definition: { broken: true } } });
    const run = await finished(await launch(z));
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatchObject({ code: 'INTERNAL' });
  });

  it('auto-pauses a zap after consecutive failures', async () => {
    const z = await zapWith([step('step1', 'boom')]);
    for (let i = 0; i < 3; i++) await finished(await launch(z));
    await waitFor(async () => (await prisma.zap.findUnique({ where: { id: z.zap.id } }))?.status === 'ERROR', 5_000, 'auto-pause');
  });
});

describe('triggers', () => {
  it('fires schedules into runs', async () => {
    const z = await zapWith([step('step1', 'echo', { at: '{{ trigger.scheduledFor }}' })], { appKey: 'schedule', operationKey: 'every', config: { mode: 'interval', intervalMinutes: 1 } });
    await prisma.triggerState.create({ data: { zapId: z.zap.id, workspaceId: z.ws.id, kind: 'schedule' } });
    await ff.queues.triggers.upsertJobScheduler(triggerSchedulerId(z.zap.id), { every: 300 }, { name: 'schedule', data: { zapId: z.zap.id, workspaceId: z.ws.id, kind: 'schedule' } });
    const runs = await waitFor(async () => {
      const r = await prisma.run.findMany({ where: { zapId: z.zap.id, status: 'SUCCEEDED' }, include: { steps: true } });
      return r.length >= 2 ? r : null;
    }, 8_000, 'two scheduled runs');
    expect(runs[0]!.source).toBe('SCHEDULE');
    expect(runs[0]!.steps[0]!.output).toMatchObject({ at: expect.stringMatching(/^\d{4}-/) });
    await ff.queues.triggers.removeJobScheduler(triggerSchedulerId(z.zap.id));
  });

  it('polls, baselines, then runs new items once', async () => {
    const z = await zapWith([step('step1', 'echo', { title: '{{ trigger.title }}' })], { appKey: 'kit', operationKey: 'poll' });
    await prisma.triggerState.create({ data: { zapId: z.zap.id, workspaceId: z.ws.id, kind: 'poll' } });
    const data = { zapId: z.zap.id, workspaceId: z.ws.id, kind: 'poll' as const };
    pollItems.push({ id: '1', data: { title: 'old' } });
    await ff.queues.triggers.add('poll', data);
    await waitFor(async () => (await prisma.triggerState.findUnique({ where: { zapId: z.zap.id } }))?.lastPolledAt, 5_000, 'baseline poll');

    pollItems.push({ id: '2', data: { title: 'new' } });
    await ff.queues.triggers.add('poll', data);
    await ff.queues.triggers.add('poll', data);
    const run = await waitFor(async () => prisma.run.findFirst({ where: { zapId: z.zap.id, status: 'SUCCEEDED' }, include: { steps: true } }), 8_000, 'polled run');
    expect(run.steps[0]!.output).toEqual({ title: 'new' });
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.run.count({ where: { zapId: z.zap.id } })).toBe(1);
  });
});

describe('test-step queue', () => {
  it('returns the result to the waiting caller and saves the sample', async () => {
    const z = await zapWith([]);
    await prisma.zapStep.create({ data: { zapId: z.zap.id, workspaceId: z.ws.id, key: 'trigger', type: 'TRIGGER', position: 0, appKey: 'webhook', operationKey: 'catchHook', sampleOutput: { body: { n: 2 } } } });
    const stepRow = await prisma.zapStep.create({ data: { zapId: z.zap.id, workspaceId: z.ws.id, key: 'step1', type: 'ACTION', position: 1, appKey: 'kit', operationKey: 'code', config: { code: 'return { sq: input.n * input.n }', data: { n: '{{ trigger.body.n }}' } } } });

    const queue = new Queue(QUEUES.testStep, { connection: redis });
    const events = new QueueEvents(QUEUES.testStep, { connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }) });
    await events.waitUntilReady();
    const job = await queue.add('test', { workspaceId: z.ws.id, zapId: z.zap.id, stepId: stepRow.id });
    const result = (await job.waitUntilFinished(events, 10_000)) as TestStepResult;
    expect(result).toMatchObject({ status: 'success', output: { sq: 4 } });
    expect((await prisma.zapStep.findUniqueOrThrow({ where: { id: stepRow.id } })).sampleOutput).toEqual({ sq: 4 });
    await events.close();
    await queue.close();
  });
});

describe('maintenance', () => {
  it('re-enqueues and executes orphaned runs', async () => {
    await ff.close();
    await start({ maintenanceEveryMs: 300 });
    const z = await zapWith([step('step1', 'echo', { ok: true })]);
    // A run whose job never made it to Redis.
    const orphan = await prisma.run.create({
      data: { workspaceId: z.ws.id, zapId: z.zap.id, zapVersionId: z.version.id, source: 'WEBHOOK', idempotencyKey: 'orphan', triggerOutput: {}, queuedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const run = await finished(orphan.id, 8_000);
    expect(run.status).toBe('SUCCEEDED');
  });
});
