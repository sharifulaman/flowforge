import { QUEUES, triggerSchedulerId, type RunJobData, type TriggerJobData, type ZapDefinition } from '@flowforge/shared';
import { SecretBox } from '@flowforge/shared/node';
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore, RunLauncher, SafeHttpClient, silentConnectorLogger, TriggerManager, TriggerSetupError } from '../src';
import { setFailSubscribe, subscribeCalls, testRegistry, unsubscribeCalls } from './fixtures';
import { prisma, redisConnection, resetDb, seedZap } from './helpers';

const connection = redisConnection();
const runsQueue = new Queue<RunJobData>(QUEUES.runs, { connection });
const triggersQueue = new Queue<TriggerJobData>(QUEUES.triggers, { connection });
const registry = testRegistry();
const credentials = new CredentialStore(prisma, new SecretBox({ 1: randomBytes(32) }, 1), registry);

beforeAll(async () => {
  await connection.flushdb();
});
beforeEach(async () => {
  await resetDb();
  await connection.flushdb();
  subscribeCalls.length = 0;
  unsubscribeCalls.length = 0;
  setFailSubscribe(false);
});
afterAll(async () => {
  await runsQueue.close();
  await triggersQueue.close();
  connection.disconnect();
  await prisma.$disconnect();
});

describe('RunLauncher', () => {
  it('creates the run and enqueues a job with jobId = runId', async () => {
    const { workspace, zap, version } = await seedZap();
    const launcher = new RunLauncher(prisma, runsQueue);
    const res = await launcher.launch({
      workspaceId: workspace.id,
      zapId: zap.id,
      zapVersionId: version.id,
      source: 'WEBHOOK',
      triggerOutput: { body: { a: 1 } },
      idempotencyKey: 'k1',
    });
    expect(res.duplicate).toBe(false);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: res.runId } });
    expect(run).toMatchObject({ status: 'QUEUED', source: 'WEBHOOK', triggerOutput: { body: { a: 1 } } });
    const job = await runsQueue.getJob(res.runId);
    expect(job?.data).toEqual({ runId: res.runId, workspaceId: workspace.id });
    expect(job?.opts.attempts).toBe(5);
  });

  it('is idempotent per zap', async () => {
    const { workspace, zap, version } = await seedZap();
    const launcher = new RunLauncher(prisma, runsQueue);
    const params = { workspaceId: workspace.id, zapId: zap.id, zapVersionId: version.id, source: 'WEBHOOK' as const, triggerOutput: {}, idempotencyKey: 'same' };
    const [a, b] = await Promise.all([launcher.launch(params), launcher.launch(params)]);
    expect(a.runId).toBe(b.runId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await prisma.run.count()).toBe(1);
    expect(await runsQueue.count()).toBe(1);
  });

  it('seeds completed step runs for replays and rejects oversized payloads', async () => {
    const { workspace, zap, version } = await seedZap();
    const launcher = new RunLauncher(prisma, runsQueue);
    const { runId } = await launcher.launch({
      workspaceId: workspace.id,
      zapId: zap.id,
      zapVersionId: version.id,
      source: 'REPLAY',
      triggerOutput: {},
      idempotencyKey: 'replay:1',
      seedStepRuns: [{ workspaceId: workspace.id, stepKey: 'step1', position: 1, appKey: 'acme', operationKey: 'send', status: 'SUCCEEDED', output: { ok: 1 } }],
    });
    expect(await prisma.stepRun.findMany({ where: { runId } })).toMatchObject([{ stepKey: 'step1', status: 'SUCCEEDED' }]);
    await expect(
      launcher.launch({ workspaceId: workspace.id, zapId: zap.id, zapVersionId: version.id, source: 'WEBHOOK', triggerOutput: { big: 'x'.repeat(600_000) }, idempotencyKey: 'big' }),
    ).rejects.toThrow(/exceeds/);
  });
});

describe('TriggerManager', () => {
  const http = new SafeHttpClient();
  const manager = new TriggerManager({ prisma, triggersQueue, registry, credentials, http, logger: silentConnectorLogger, hooksBaseUrl: 'https://hooks.test/' });

  const def = (trigger: Partial<ZapDefinition['trigger']>): ZapDefinition => ({
    schemaVersion: 1,
    trigger: { key: 'trigger', name: null, appKey: 'webhook', operationKey: 'catchHook', connectionId: null, config: {}, timeoutMs: null, ...trigger },
    steps: [],
  });

  it('webhook: issues a stable token across re-activation and pause', async () => {
    const { zap } = await seedZap();
    await manager.activate(zap, def({}));
    const s1 = await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } });
    expect(s1.kind).toBe('webhook');
    expect(manager.hookUrl(s1.kind, s1.hookToken)).toBe(`https://hooks.test/hooks/${s1.hookToken}`);
    await manager.deactivate(zap);
    await manager.activate(zap, def({}), def({}));
    const s2 = await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } });
    expect(s2.hookToken).toBe(s1.hookToken);
    expect(await manager.rotateHookToken(zap.id)).not.toBe(s1.hookToken);
  });

  it('schedule: upserts a job scheduler and removes it on deactivate', async () => {
    const { zap } = await seedZap();
    await manager.activate(zap, def({ appKey: 'schedule', operationKey: 'every', config: { mode: 'cron', cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' } }));
    const scheds = await triggersQueue.getJobSchedulers();
    expect(scheds).toHaveLength(1);
    expect(scheds[0]).toMatchObject({ key: triggerSchedulerId(zap.id), pattern: '0 9 * * 1-5', tz: 'Europe/Berlin' });

    // Re-activate with an interval: replaced, not duplicated.
    await manager.activate(zap, def({ appKey: 'schedule', operationKey: 'every', config: { mode: 'interval', intervalMinutes: 5 } }));
    const again = await triggersQueue.getJobSchedulers();
    expect(again).toHaveLength(1);
    expect(again[0]!.every).toBe(300_000);

    await manager.deactivate(zap);
    expect(await triggersQueue.getJobSchedulers()).toHaveLength(0);
  });

  it('polling: schedules at the trigger interval and resets the cursor when the trigger changes', async () => {
    const { zap } = await seedZap();
    const polling = def({ appKey: 'acme', operationKey: 'poller', connectionId: null });
    await manager.activate(zap, polling);
    expect((await triggersQueue.getJobSchedulers())[0]!.every).toBe(120_000);
    await prisma.triggerState.update({ where: { zapId: zap.id }, data: { cursor: { since: 5 } } });
    await manager.activate(zap, polling, polling);
    expect((await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } })).cursor).toEqual({ since: 5 });
    await manager.activate(zap, def({}), polling);
    const state = await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } });
    expect(state.cursor).toBeNull();
    expect(state.kind).toBe('webhook');
    expect(await triggersQueue.getJobSchedulers()).toHaveLength(0);
  });

  it('app webhook: subscribes with credentials, unsubscribes on deactivate', async () => {
    const { zap, workspace } = await seedZap();
    const conn = await prisma.connection.create({
      data: { workspaceId: workspace.id, appKey: 'acme', name: 'c', authType: 'API_KEY', createdById: 'u', ...credentials.encrypt(workspace.id, 'acme', { apiKey: 'k' }) },
    });
    const d = def({ appKey: 'acme', operationKey: 'newThing', connectionId: conn.id, config: { channel: 'general' } });
    await manager.activate(zap, d);
    const state = await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } });
    expect(subscribeCalls).toEqual([{ webhookUrl: `https://hooks.test/hooks/app/${state.hookToken}`, input: { channel: 'general' }, auth: { apiKey: 'k' } }]);

    // Same trigger again → no duplicate subscription.
    await manager.activate(zap, d, d);
    expect(subscribeCalls).toHaveLength(1);

    await manager.deactivate(zap);
    expect(unsubscribeCalls).toEqual([{ hookId: 'h-1' }]);
    expect((await prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } })).subscription).toBeNull();
  });

  it('app webhook: surfaces provider failures as TriggerSetupError', async () => {
    const { zap } = await seedZap();
    setFailSubscribe(true);
    await expect(manager.activate(zap, def({ appKey: 'acme', operationKey: 'newThing', config: { channel: 'x' } }))).rejects.toBeInstanceOf(TriggerSetupError);
  });
});
