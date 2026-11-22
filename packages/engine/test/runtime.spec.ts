import { AuthError } from '@flowforge/connector-sdk';
import { QUEUES, type RunJobData, type TriggerJobData, type ZapDefinition, type StepDefinition } from '@flowforge/shared';
import { SecretBox } from '@flowforge/shared/node';
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupPollDedupe,
  computeBackoff,
  CredentialStore,
  hasConsecutiveFailures,
  MAX_BACKOFF_MS,
  reconcileOrphanedRuns,
  RunLauncher,
  SafeHttpClient,
  silentConnectorLogger,
  StepTester,
  TriggerManager,
  TriggerRuntime,
} from '../src';
import { calls, executorRegistry, pollState } from './fixtures';
import { prisma, redisConnection, resetDb, seedZap } from './helpers';

const connection = redisConnection();
const runsQueue = new Queue<RunJobData>(QUEUES.runs, { connection });
const triggersQueue = new Queue<TriggerJobData>(QUEUES.triggers, { connection });
const registry = executorRegistry();
const credentials = new CredentialStore(prisma, new SecretBox({ 1: randomBytes(32) }, 1), registry);
const http = new SafeHttpClient();
const launcher = new RunLauncher(prisma, runsQueue);
const triggers = new TriggerManager({ prisma, triggersQueue, registry, credentials, http, logger: silentConnectorLogger, hooksBaseUrl: 'https://h.test' });
const runtime = new TriggerRuntime({ prisma, registry, credentials, http, launcher, triggers, logger: silentConnectorLogger });
const tester = new StepTester({ prisma, registry, credentials, http, sandbox: { run: async () => ({ result: null, logs: [] }) } });

beforeEach(async () => {
  await resetDb();
  await connection.flushdb();
  pollState.items = [];
  pollState.cursorsSeen = [];
  pollState.fail = undefined;
  for (const k of Object.keys(calls)) delete calls[k];
});
afterAll(async () => {
  await runsQueue.close();
  await triggersQueue.close();
  connection.disconnect();
  await http.close();
  await prisma.$disconnect();
});

const trig = (over: Partial<StepDefinition>): StepDefinition => ({ key: 'trigger', name: null, appKey: 'testkit', operationKey: 'poll', connectionId: null, config: {}, timeoutMs: null, ...over });

async function liveZap(trigger: StepDefinition) {
  const s = await seedZap();
  const def: ZapDefinition = { schemaVersion: 1, trigger, steps: [{ key: 'step1', name: null, appKey: 'testkit', operationKey: 'echo', connectionId: null, config: {}, timeoutMs: null }] };
  await prisma.zapVersion.update({ where: { id: s.version.id }, data: { definition: def as never } });
  await prisma.zap.update({ where: { id: s.zap.id }, data: { status: 'ACTIVE', publishedVersionId: s.version.id } });
  await prisma.triggerState.create({ data: { zapId: s.zap.id, workspaceId: s.workspace.id, kind: trigger.operationKey === 'poll' ? 'poll' : 'schedule' } });
  return { ...s, data: { zapId: s.zap.id, workspaceId: s.workspace.id, kind: 'poll' as const } };
}

describe('polling', () => {
  it('records a baseline on the first poll, then starts one run per new item (deduped)', async () => {
    const { data, zap } = await liveZap(trig({}));
    pollState.items = [{ id: 'a', data: { title: 'A' } }, { id: 'b', data: { title: 'B' } }];
    expect(await runtime.poll(data)).toEqual({ launched: [], skipped: 'baseline' });
    expect(await prisma.run.count()).toBe(0);

    pollState.items = [{ id: 'b', data: { title: 'B' } }, { id: 'c', data: { title: 'C' } }, { id: 'd', data: { title: 'D' } }];
    const second = await runtime.poll(data);
    expect(second.launched).toHaveLength(2);
    const runs = await prisma.run.findMany({ orderBy: { queuedAt: 'asc' } });
    expect(runs.map((r) => [r.source, r.triggerOutput, r.idempotencyKey])).toEqual([
      ['POLL', { title: 'C' }, 'poll:c'],
      ['POLL', { title: 'D' }, 'poll:d'],
    ]);
    expect(await runsQueue.count()).toBe(2);

    // Same items again → nothing new.
    expect((await runtime.poll(data)).launched).toEqual([]);
    expect(pollState.cursorsSeen).toEqual([undefined, { seen: 2 }, { seen: 3 }]);
    const state = await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } });
    expect(state.cursor).toEqual({ seen: 3 });
    expect(state.lastFiredAt).not.toBeNull();
  });

  it('records transient errors and rethrows (next tick retries)', async () => {
    const { data, zap } = await liveZap(trig({}));
    pollState.fail = 'net';
    await expect(runtime.poll(data)).rejects.toThrow(/503/);
    expect((await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } })).lastError).toMatch(/503/);
    expect((await prisma.zap.findUniqueOrThrow({ where: { id: zap.id } })).status).toBe('ACTIVE');
  });

  it('switches the zap to ERROR on auth failures', async () => {
    const { data, zap } = await liveZap(trig({}));
    pollState.fail = 'auth';
    await expect(runtime.poll(data)).rejects.toBeInstanceOf(AuthError);
    expect((await prisma.zap.findUniqueOrThrow({ where: { id: zap.id } })).status).toBe('ERROR');
  });

  it('skips paused or deleted zaps', async () => {
    const { data, zap } = await liveZap(trig({}));
    await prisma.zap.update({ where: { id: zap.id }, data: { status: 'PAUSED' } });
    expect(await runtime.poll(data)).toEqual({ launched: [], skipped: 'inactive' });
    expect(pollState.cursorsSeen).toEqual([]);
  });
});

describe('schedule', () => {
  it('launches one run per tick, idempotently', async () => {
    const { data } = await liveZap(trig({ appKey: 'schedule', operationKey: 'every', config: { mode: 'interval', timezone: 'Europe/Paris' } }));
    const when = new Date('2026-05-01T09:00:00Z');
    const a = await runtime.fireSchedule({ ...data, kind: 'schedule' }, 'repeat:zap:1:1000', when);
    const b = await runtime.fireSchedule({ ...data, kind: 'schedule' }, 'repeat:zap:1:1000', when);
    expect(a.launched).toEqual(b.launched);
    const run = await prisma.run.findFirstOrThrow();
    expect(run.source).toBe('SCHEDULE');
    expect(run.triggerOutput).toMatchObject({ scheduledFor: '2026-05-01T09:00:00.000Z', timezone: 'Europe/Paris' });
    expect(await prisma.run.count()).toBe(1);
  });
});

describe('StepTester', () => {
  async function draftZap() {
    const s = await seedZap();
    const mk = (key: string, type: 'TRIGGER' | 'ACTION', position: number, appKey: string, operationKey: string, config: object = {}, sampleOutput?: object) =>
      prisma.zapStep.create({ data: { zapId: s.zap.id, workspaceId: s.workspace.id, key, type, position, appKey, operationKey, config, ...(sampleOutput ? { sampleOutput } : {}) } });
    return { ...s, mk };
  }

  it('tests an action using earlier samples and stores the output as its sample', async () => {
    const z = await draftZap();
    await z.mk('trigger', 'TRIGGER', 0, 'webhook', 'catchHook', {}, { body: { n: 5 } });
    const step = await z.mk('step1', 'ACTION', 1, 'testkit', 'typed', { n: '{{ trigger.body.n }}' });
    const res = await tester.test({ workspaceId: z.workspace.id, zapId: z.zap.id, stepId: step.id });
    expect(res).toMatchObject({ status: 'success', input: { n: 5, label: 'none' }, output: { doubled: 10 }, error: null });
    expect((await prisma.zapStep.findUniqueOrThrow({ where: { id: step.id } })).sampleOutput).toEqual({ doubled: 10, label: 'none' });
  });

  it('falls back to example outputs, reports errors without saving, and flags isTest', async () => {
    const z = await draftZap();
    await z.mk('trigger', 'TRIGGER', 0, 'webhook', 'catchHook'); // no sample → connector example
    const echo = await z.mk('step1', 'ACTION', 1, 'testkit', 'echo', { email: '{{ trigger.body.email }}' });
    const boom = await z.mk('step2', 'ACTION', 2, 'testkit', 'boom');
    expect(await tester.test({ workspaceId: z.workspace.id, zapId: z.zap.id, stepId: echo.id })).toMatchObject({
      status: 'success',
      output: { email: 'jane@example.com', isTest: true },
    });
    const failed = await tester.test({ workspaceId: z.workspace.id, zapId: z.zap.id, stepId: boom.id });
    expect(failed).toMatchObject({ status: 'error', error: { message: 'bad request: 400' } });
    expect((await prisma.zapStep.findUniqueOrThrow({ where: { id: boom.id } })).sampleOutput).toBeNull();
  });

  it('does not actually wait on Delay steps during tests', async () => {
    const z = await draftZap();
    await z.mk('trigger', 'TRIGGER', 0, 'webhook', 'catchHook', {}, { a: 1 });
    const wait = await z.mk('step1', 'ACTION', 1, 'testkit', 'wait', { ms: 3_600_000 });
    const res = await tester.test({ workspaceId: z.workspace.id, zapId: z.zap.id, stepId: wait.id });
    expect(res.status).toBe('success');
    expect(res.output).toHaveProperty('wouldResumeAt');
  });

  it('tests triggers: webhook needs a captured request; polling fetches the newest item', async () => {
    const z = await draftZap();
    const hook = await z.mk('trigger', 'TRIGGER', 0, 'webhook', 'catchHook');
    expect(await tester.test({ workspaceId: z.workspace.id, zapId: z.zap.id, stepId: hook.id })).toMatchObject({ status: 'error', error: { code: 'NO_SAMPLE' } });

    await prisma.zapStep.update({ where: { id: hook.id }, data: { appKey: 'testkit', operationKey: 'poll' } });
    pollState.items = [{ id: '1', data: { title: 'old' } }, { id: '2', data: { title: 'new' } }];
    const res = await tester.test({ workspaceId: z.workspace.id, zapId: z.zap.id, stepId: hook.id });
    expect(res).toMatchObject({ status: 'success', output: { title: 'new' } });
    expect((await prisma.zapStep.findUniqueOrThrow({ where: { id: hook.id } })).sampleOutput).toEqual({ title: 'new' });
  });

  it('is tenant-scoped', async () => {
    const z = await draftZap();
    const other = await seedZap();
    const step = await z.mk('step1', 'ACTION', 1, 'testkit', 'echo');
    expect(await tester.test({ workspaceId: other.workspace.id, zapId: z.zap.id, stepId: step.id })).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } });
  });
});

describe('maintenance', () => {
  it('re-enqueues orphaned runs', async () => {
    const { workspace, zap, version } = await seedZap();
    const old = new Date(Date.now() - 10 * 60_000);
    const orphan = await prisma.run.create({ data: { workspaceId: workspace.id, zapId: zap.id, zapVersionId: version.id, source: 'WEBHOOK', idempotencyKey: 'o', triggerOutput: {}, queuedAt: old } });
    const fresh = await prisma.run.create({ data: { workspaceId: workspace.id, zapId: zap.id, zapVersionId: version.id, source: 'WEBHOOK', idempotencyKey: 'f', triggerOutput: {} } });
    const healthy = await launcher.launch({ workspaceId: workspace.id, zapId: zap.id, zapVersionId: version.id, source: 'WEBHOOK', triggerOutput: {}, idempotencyKey: 'h' });
    await prisma.run.update({ where: { id: healthy.runId }, data: { queuedAt: old } });

    expect(await reconcileOrphanedRuns(prisma, runsQueue)).toEqual([orphan.id]);
    expect(await runsQueue.getJob(orphan.id)).toBeTruthy();
    expect(await runsQueue.getJob(fresh.id)).toBeUndefined();
    expect(await reconcileOrphanedRuns(prisma, runsQueue)).toEqual([]);
  });

  it('cleans up old dedupe keys and detects failure streaks', async () => {
    const { workspace, zap, version } = await seedZap();
    await prisma.pollDedupe.createMany({ data: [{ zapId: zap.id, itemKey: 'old', createdAt: new Date(Date.now() - 40 * 86_400_000) }, { zapId: zap.id, itemKey: 'new' }] });
    expect(await cleanupPollDedupe(prisma, 30)).toBe(1);

    const mk = (status: 'FAILED' | 'SUCCEEDED', i: number) =>
      prisma.run.create({ data: { workspaceId: workspace.id, zapId: zap.id, zapVersionId: version.id, source: 'WEBHOOK', idempotencyKey: `r${i}`, triggerOutput: {}, status, finishedAt: new Date(Date.now() + i * 1000) } });
    await mk('SUCCEEDED', 0);
    for (let i = 1; i <= 9; i++) await mk('FAILED', i);
    expect(await hasConsecutiveFailures(prisma, zap.id, 10)).toBe(false);
    await mk('FAILED', 10);
    expect(await hasConsecutiveFailures(prisma, zap.id, 10)).toBe(true);
  });
});

describe('computeBackoff', () => {
  it('grows exponentially with bounded jitter and respects Retry-After', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => computeBackoff(n, undefined, 10_000, mid))).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(computeBackoff(1, undefined, 10_000, () => 0)).toBe(8_000);
    expect(computeBackoff(1, undefined, 10_000, () => 0.9999)).toBeLessThanOrEqual(12_000);
    expect(computeBackoff(20, undefined, 10_000, mid)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoff(1, 42_000)).toBe(42_000);
    expect(computeBackoff(1, 10 * 3_600_000)).toBe(3_600_000);
  });
});
