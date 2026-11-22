import { QUEUES, triggerSchedulerId } from '@flowforge/shared';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscriptions, unsubscriptions } from './fixtures';
import { createTestApp, resetState, signUp, type TestContext } from './helpers';

let ctx: TestContext;
let triggersQueue: Queue;
beforeAll(async () => {
  ctx = await createTestApp();
  triggersQueue = new Queue(QUEUES.triggers, { connection: ctx.redis });
});
afterAll(async () => {
  await triggersQueue.close();
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
  subscriptions.length = 0;
  unsubscriptions.length = 0;
});

type User = Awaited<ReturnType<typeof signUp>>;

async function newZap(u: User, name = 'Lead router') {
  const res = await u.api.post(`/workspaces/${u.ws}/zaps`, { name });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function acmeConnection(u: User) {
  return (await u.api.post(`/workspaces/${u.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'key1' } })).json();
}

describe('zap CRUD', () => {
  it('creates a draft, lists with filters and cursor pagination', async () => {
    const u = await signUp(ctx, 'a@example.com');
    for (let i = 0; i < 5; i++) await newZap(u, `Zap ${i}`);
    await newZap(u, 'Special one');

    const page1 = (await u.api.get(`/workspaces/${u.ws}/zaps?limit=4`)).json();
    expect(page1.items).toHaveLength(4);
    expect(page1.items[0]).toMatchObject({ name: 'Special one', status: 'DRAFT', apps: [], publishedVersion: null });
    const page2 = (await u.api.get(`/workspaces/${u.ws}/zaps?limit=4&cursor=${page1.nextCursor}`)).json();
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((z: { id: string }) => z.id);
    expect(new Set(ids).size).toBe(6);

    expect((await u.api.get(`/workspaces/${u.ws}/zaps?q=special`)).json().items).toHaveLength(1);
    expect((await u.api.get(`/workspaces/${u.ws}/zaps?status=ACTIVE`)).json().items).toHaveLength(0);
    expect((await u.api.get(`/workspaces/${u.ws}/zaps?limit=1000`)).statusCode).toBe(400);
  });

  it('isolates zaps between workspaces', async () => {
    const a = await signUp(ctx, 'a@example.com');
    const b = await signUp(ctx, 'b@example.com');
    const zap = await newZap(a);
    expect((await b.api.get(`/workspaces/${b.ws}/zaps/${zap.id}`)).statusCode).toBe(404);
    expect((await b.api.patch(`/workspaces/${b.ws}/zaps/${zap.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await b.api.post(`/workspaces/${b.ws}/zaps/${zap.id}/steps`, { appKey: 'webhook', operationKey: 'x' })).statusCode).toBe(400);
    expect((await b.api.del(`/workspaces/${b.ws}/zaps/${zap.id}`)).statusCode).toBe(404);
    expect((await b.api.get(`/workspaces/${b.ws}/zaps`)).json().items).toHaveLength(0);
  });
});

describe('step editing', () => {
  it('sets a webhook trigger and exposes its URL before publishing', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const zap = await newZap(u);
    const res = await u.api.put(`/workspaces/${u.ws}/zaps/${zap.id}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.steps).toMatchObject([{ key: 'trigger', type: 'TRIGGER', position: 0, appKey: 'webhook' }]);
    expect(detail.trigger.hookUrl).toMatch(/^https:\/\/hooks\.flowforge\.test\/hooks\/[A-Za-z0-9_-]{32}$/);

    expect((await u.api.put(`/workspaces/${u.ws}/zaps/${zap.id}/trigger`, { appKey: 'webhook', operationKey: 'nope' })).statusCode).toBe(400);
    expect((await u.api.put(`/workspaces/${u.ws}/zaps/${zap.id}/trigger`, { appKey: 'ghost', operationKey: 'x' })).statusCode).toBe(400);
  });

  it('adds, inserts, updates, reorders and deletes steps with stable keys', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const conn = await acmeConnection(u);
    const zap = await newZap(u);
    const base = `/workspaces/${u.ws}/zaps/${zap.id}`;
    await u.api.put(`${base}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });

    const add = (body: object) => u.api.post(`${base}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, ...body });
    await add({ config: { email: '{{ trigger.body.email }}' } }); // step1
    await add({ config: { email: '{{ step1.email }}' } }); // step2
    const inserted = (await add({ afterKey: 'trigger', name: 'First!' })).json(); // step3 at position 1
    expect(inserted.steps.map((s: { key: string }) => s.key)).toEqual(['trigger', 'step3', 'step1', 'step2']);
    expect(inserted.steps.map((s: { position: number }) => s.position)).toEqual([0, 1, 2, 3]);
    expect(inserted.warnings).toEqual([]);

    const step1 = inserted.steps.find((s: { key: string }) => s.key === 'step1');
    const step2 = inserted.steps.find((s: { key: string }) => s.key === 'step2');
    const step3 = inserted.steps.find((s: { key: string }) => s.key === 'step3');

    // Reorder so step2 (which reads step1) runs before step1 → warning, not error.
    const reordered = (await u.api.post(`${base}/steps/reorder`, { order: [step2.id, step3.id, step1.id] })).json();
    expect(reordered.steps.map((s: { key: string }) => s.key)).toEqual(['trigger', 'step2', 'step3', 'step1']);
    expect(reordered.warnings).toEqual([
      { stepKey: 'step2', location: 'email', message: '"{{ step1.email }}" uses data from "step1", which runs after this step' },
    ]);
    expect((await u.api.post(`${base}/steps/reorder`, { order: [step2.id, step3.id] })).statusCode).toBe(400);

    const patched = (await u.api.patch(`${base}/steps/${step3.id}`, { name: 'Renamed', config: { email: 'x@y.co' }, timeoutMs: 5_000 })).json();
    expect(patched.steps.find((s: { key: string }) => s.key === 'step3')).toMatchObject({ name: 'Renamed', config: { email: 'x@y.co' }, timeoutMs: 5000 });

    // Switching app clears the connection and config.
    const switched = (await u.api.patch(`${base}/steps/${step3.id}`, { appKey: 'oauthy', operationKey: 'ping' })).json();
    expect(switched.steps.find((s: { key: string }) => s.key === 'step3')).toMatchObject({ appKey: 'oauthy', connectionId: null, config: {} });

    const afterDelete = (await u.api.del(`${base}/steps/${step2.id}`)).json();
    expect(afterDelete.steps.map((s: { key: string; position: number }) => [s.key, s.position])).toEqual([
      ['trigger', 0],
      ['step3', 1],
      ['step1', 2],
    ]);

    // New steps never reuse a deleted key.
    expect((await add({})).json().steps.at(-1).key).toBe('step4');
  });

  it('serializes concurrent step additions', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const zap = await newZap(u);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/steps`, { appKey: 'oauthy', operationKey: 'ping' })),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const steps = (await u.api.get(`/workspaces/${u.ws}/zaps/${zap.id}`)).json().steps;
    expect(steps.map((s: { key: string }) => s.key).sort()).toEqual(['step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7', 'step8']);
    expect(steps.map((s: { position: number }) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('returns field-picker samples (real or example)', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const conn = await acmeConnection(u);
    const zap = await newZap(u);
    await u.api.put(`/workspaces/${u.ws}/zaps/${zap.id}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
    await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id });
    await ctx.prisma.zapStep.updateMany({ where: { zapId: zap.id, key: 'step1' }, data: { sampleOutput: { id: 'real' }, sampleAt: new Date() } });
    const samples = (await u.api.get(`/workspaces/${u.ws}/zaps/${zap.id}/samples`)).json();
    expect(samples).toMatchObject([
      { key: 'trigger', isExample: true, sample: { method: 'POST', body: { email: 'jane@example.com' } } },
      { key: 'step1', isExample: false, sample: { id: 'real' } },
    ]);
  });
});

describe('publishing', () => {
  it('reports every blocking issue', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const zap = await newZap(u);
    const empty = await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/enable`);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.issues).toEqual([
      { path: 'zap', message: 'Add a trigger to start this Zap' },
      { path: 'zap', message: 'Add at least one action' },
    ]);

    await u.api.put(`/workspaces/${u.ws}/zaps/${zap.id}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
    await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/steps`, { appKey: 'acme', operationKey: 'createContact', config: { email: 'nope' } });
    await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/steps`, { appKey: 'oauthy', operationKey: 'ping', config: { x: '{{ step9.y }}' } });
    const res = await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/enable`);
    expect(res.json().error.issues).toEqual([
      { path: 'step1.connectionId', message: 'Choose a Acme account' },
      { path: 'step1.email', message: expect.stringMatching(/email/) },
      { path: 'step2.connectionId', message: 'Choose a OAuthy account' },
      { path: 'step2.x', message: 'Unknown field' },
      { path: 'step2.x', message: '"{{ step9.y }}" refers to unknown step "step9"' },
    ]);
    expect((await u.api.get(`/workspaces/${u.ws}/zaps/${zap.id}`)).json().status).toBe('DRAFT');
  });

  it('publishes versions only when the draft changed', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const conn = await acmeConnection(u);
    const zap = await newZap(u);
    const base = `/workspaces/${u.ws}/zaps/${zap.id}`;
    await u.api.put(`${base}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
    const draft = (await u.api.post(`${base}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, config: { email: '{{ trigger.body.email }}' } })).json();
    expect(draft.hasUnpublishedChanges).toBe(true);

    const on = (await u.api.post(`${base}/enable`)).json();
    expect(on).toMatchObject({ status: 'ACTIVE', publishedVersion: 1, hasUnpublishedChanges: false, apps: ['webhook', 'acme'] });
    const hookUrl = on.trigger.hookUrl;

    // Idempotent enable.
    expect((await u.api.post(`${base}/enable`)).json().publishedVersion).toBe(1);

    // Editing the draft doesn't touch the live version until re-published.
    const edited = (await u.api.patch(`${base}/steps/${draft.steps[1].id}`, { config: { email: 'fixed@example.com' } })).json();
    expect(edited).toMatchObject({ status: 'ACTIVE', publishedVersion: 1, hasUnpublishedChanges: true });
    const v2 = (await u.api.post(`${base}/enable`)).json();
    expect(v2.publishedVersion).toBe(2);
    expect(v2.trigger.hookUrl).toBe(hookUrl); // URL survives re-publishing

    const versions = (await u.api.get(`${base}/versions`)).json();
    expect(versions.map((v: { version: number; isPublished: boolean }) => [v.version, v.isPublished])).toEqual([
      [2, true],
      [1, false],
    ]);
    const stored = await ctx.prisma.zapVersion.findFirstOrThrow({ where: { zapId: zap.id, version: 1 } });
    expect(stored.definition).toMatchObject({ steps: [{ key: 'step1', config: { email: '{{ trigger.body.email }}' } }] });

    const off = (await u.api.post(`${base}/disable`)).json();
    expect(off.status).toBe('PAUSED');
    expect((await u.api.post(`${base}/enable`)).json().publishedVersion).toBe(2);
  });

  it('registers schedule triggers in BullMQ and removes them on disable/delete', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const zap = await newZap(u);
    const base = `/workspaces/${u.ws}/zaps/${zap.id}`;
    await u.api.put(`${base}/trigger`, { appKey: 'schedule', operationKey: 'every', config: { mode: 'cron', cron: '*/5 * * * *', timezone: 'UTC' } });
    await u.api.post(`${base}/steps`, { appKey: 'webhook', operationKey: 'catchHook' }); // invalid action → 400
    const bad = await u.api.post(`${base}/steps`, { appKey: 'webhook', operationKey: 'catchHook' });
    expect(bad.statusCode).toBe(400);

    const conn = await acmeConnection(u);
    await u.api.post(`${base}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, config: { email: 'a@b.co' } });
    expect((await u.api.post(`${base}/enable`)).statusCode).toBe(200);
    const [sched] = await triggersQueue.getJobSchedulers();
    expect(sched).toMatchObject({ key: triggerSchedulerId(zap.id), pattern: '*/5 * * * *' });

    await u.api.post(`${base}/disable`);
    expect(await triggersQueue.getJobSchedulers()).toHaveLength(0);
    await u.api.post(`${base}/enable`);
    expect(await triggersQueue.getJobSchedulers()).toHaveLength(1);
    expect((await u.api.del(base)).statusCode).toBe(204);
    expect(await triggersQueue.getJobSchedulers()).toHaveLength(0);
    expect((await u.api.get(base)).statusCode).toBe(404);
  });

  it('rejects invalid cron at publish time', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const zap = await newZap(u);
    const base = `/workspaces/${u.ws}/zaps/${zap.id}`;
    await u.api.put(`${base}/trigger`, { appKey: 'schedule', operationKey: 'every', config: { mode: 'cron', cron: '61 * * * *' } });
    await u.api.post(`${base}/steps`, { appKey: 'oauthy', operationKey: 'ping' });
    const res = await u.api.post(`${base}/enable`);
    expect(res.json().error.issues).toEqual(expect.arrayContaining([{ path: 'trigger.cron', message: expect.stringMatching(/Invalid cron/) }]));
  });

  it('subscribes app-event triggers with the provider and unsubscribes on disable', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const conn = await acmeConnection(u);
    const zap = await newZap(u);
    const base = `/workspaces/${u.ws}/zaps/${zap.id}`;
    await u.api.put(`${base}/trigger`, { appKey: 'acme', operationKey: 'newContact', connectionId: conn.id, config: { list: 'main' } });
    await u.api.post(`${base}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, config: { email: '{{ trigger.email }}' } });
    const on = (await u.api.post(`${base}/enable`)).json();
    expect(on.trigger.hookUrl).toMatch(/\/hooks\/app\//);
    expect(subscriptions).toEqual([{ webhookUrl: on.trigger.hookUrl, input: { list: 'main' } }]);
    await u.api.post(`${base}/disable`);
    expect(unsubscriptions).toEqual([{ hookId: 'hook_1' }]);
  });

  it('duplicates a zap as a draft', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const zap = await newZap(u, 'Original');
    await u.api.put(`/workspaces/${u.ws}/zaps/${zap.id}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
    await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/steps`, { appKey: 'oauthy', operationKey: 'ping' });
    const copy = (await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/duplicate`)).json();
    expect(copy).toMatchObject({ name: 'Copy of Original', status: 'DRAFT' });
    expect(copy.steps.map((s: { key: string }) => s.key)).toEqual(['trigger', 'step1']);
    expect(copy.id).not.toBe(zap.id);
  });
});
