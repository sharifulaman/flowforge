import { QUEUES } from '@flowforge/shared';
import { Queue } from 'bullmq';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIGNING_SECRET } from './fixtures';
import { createTestApp, resetState, signUp, type TestContext } from './helpers';

let ctx: TestContext;
let runsQueue: Queue;
beforeAll(async () => {
  ctx = await createTestApp();
  runsQueue = new Queue(QUEUES.runs, { connection: ctx.redis });
});
afterAll(async () => {
  await runsQueue.close();
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

type User = Awaited<ReturnType<typeof signUp>>;

/** A live webhook → acme zap. Returns the hook path (/hooks/<token>). */
async function liveWebhookZap(u: User) {
  const conn = (await u.api.post(`/workspaces/${u.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'key1' } })).json();
  const zap = (await u.api.post(`/workspaces/${u.ws}/zaps`, { name: 'Webhook zap' })).json();
  const base = `/workspaces/${u.ws}/zaps/${zap.id}`;
  await u.api.put(`${base}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
  await u.api.post(`${base}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, config: { email: '{{ trigger.body.email }}' } });
  await u.api.post(`${base}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, config: { email: '{{ step1.email }}' } });
  const on = (await u.api.post(`${base}/enable`)).json();
  return { zap: on, base, conn, path: new URL(on.trigger.hookUrl).pathname };
}

const hook = (path: string, opts: { method?: string; payload?: unknown; headers?: Record<string, string>; query?: string } = {}) =>
  ctx.app.inject({
    method: (opts.method ?? 'POST') as 'POST',
    url: `${path}${opts.query ?? ''}`,
    headers: opts.headers,
    ...(opts.payload !== undefined ? { payload: opts.payload as string } : {}),
  });

describe('catch hook', () => {
  it('accepts JSON, enqueues a run and records sanitized request data', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path, zap } = await liveWebhookZap(u);
    const res = await hook(path, {
      payload: { email: 'lead@example.com', nested: { n: 1 } },
      headers: { authorization: 'Bearer leak', cookie: 'sid=1', 'x-custom': 'keep' },
      query: '?src=form',
    });
    expect(res.statusCode).toBe(202);
    const { runId, status } = res.json();
    expect(status).toBe('accepted');

    const run = (await u.api.get(`/workspaces/${u.ws}/runs/${runId}`)).json();
    expect(run).toMatchObject({ zapId: zap.id, zapName: 'Webhook zap', status: 'QUEUED', source: 'WEBHOOK', zapVersion: 1, steps: [] });
    expect(run.triggerOutput).toMatchObject({ method: 'POST', body: { email: 'lead@example.com', nested: { n: 1 } }, query: { src: 'form' } });
    expect(run.triggerOutput.headers['x-custom']).toBe('keep');
    expect(run.triggerOutput.headers.authorization).toBeUndefined();
    expect(run.triggerOutput.headers.cookie).toBeUndefined();

    expect((await runsQueue.getJob(runId))?.data).toEqual({ runId, workspaceId: u.ws });
    const state = await ctx.prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } });
    await new Promise((r) => setTimeout(r, 50));
    expect((await ctx.prisma.triggerState.findUniqueOrThrow({ where: { zapId: zap.id } })).lastFiredAt ?? state.lastFiredAt).toBeTruthy();
  });

  it('accepts form-encoded, plain text and GET query payloads', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path } = await liveWebhookZap(u);
    const form = await hook(path, { payload: 'email=f%40example.com&plan=pro', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const text = await hook(path, { payload: '<xml>hi</xml>', headers: { 'content-type': 'application/xml' } });
    const get = await hook(path, { method: 'GET', query: '?email=q@example.com' });
    const outputs = await Promise.all(
      [form, text, get].map(async (r) => {
        expect(r.statusCode).toBe(202);
        return (await u.api.get(`/workspaces/${u.ws}/runs/${r.json().runId}`)).json().triggerOutput;
      }),
    );
    expect(outputs[0].body).toEqual({ email: 'f@example.com', plan: 'pro' });
    expect(outputs[1].body).toBe('<xml>hi</xml>');
    expect(outputs[2]).toMatchObject({ method: 'GET', body: null, query: { email: 'q@example.com' } });
  });

  it('de-duplicates by Idempotency-Key but never drops un-keyed repeats', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path } = await liveWebhookZap(u);
    const a = await hook(path, { payload: { x: 1 }, headers: { 'idempotency-key': 'evt_123' } });
    const b = await hook(path, { payload: { x: 1 }, headers: { 'idempotency-key': 'evt_123' } });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ status: 'duplicate', runId: a.json().runId });

    await hook(path, { payload: { x: 1 } });
    await hook(path, { payload: { x: 1 } });
    expect(await ctx.prisma.run.count()).toBe(3);
  });

  it('404s unknown tokens and 409s paused zaps; URL survives pause/resume', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path, base } = await liveWebhookZap(u);
    expect((await hook('/hooks/does-not-exist-but-long-enough-token')).statusCode).toBe(404);
    expect((await hook('/hooks/short')).statusCode).toBe(404);

    await u.api.post(`${base}/disable`);
    const paused = await hook(path, { payload: {} });
    expect(paused.statusCode).toBe(409);
    expect(paused.json().error.code).toBe('ZAP_INACTIVE');

    await u.api.post(`${base}/enable`);
    expect((await hook(path, { payload: {} })).statusCode).toBe(202);

    // Rotating the token kills the old URL.
    const rotated = (await u.api.post(`${base}/trigger/rotate-token`)).json();
    expect((await hook(path, { payload: {} })).statusCode).toBe(404);
    expect((await hook(new URL(rotated.trigger.hookUrl).pathname, { payload: {} })).statusCode).toBe(202);

    await u.api.del(base);
    expect((await hook(new URL(rotated.trigger.hookUrl).pathname, { payload: {} })).statusCode).toBe(404);
  });

  it('rate-limits per hook token (300/min), independently of other hooks', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const first = await liveWebhookZap(u);
    const second = await liveWebhookZap(u);
    let status = 0;
    let sent = 0;
    while (status !== 429 && sent < 310) {
      status = (await hook(first.path, { method: 'GET' })).statusCode;
      sent++;
    }
    expect(status).toBe(429);
    expect(sent).toBe(301);
    expect((await hook(second.path, { method: 'GET' })).statusCode).toBe(202);
  }, 60_000);
});

describe('app-event hook', () => {
  async function liveAppZap(u: User) {
    const conn = (await u.api.post(`/workspaces/${u.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'key1' } })).json();
    const zap = (await u.api.post(`/workspaces/${u.ws}/zaps`, { name: 'App zap' })).json();
    const base = `/workspaces/${u.ws}/zaps/${zap.id}`;
    await u.api.put(`${base}/trigger`, { appKey: 'acme', operationKey: 'newContact', connectionId: conn.id, config: { list: 'main' } });
    await u.api.post(`${base}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, config: { email: '{{ trigger.email }}' } });
    const on = (await u.api.post(`${base}/enable`)).json();
    return { base, path: new URL(on.trigger.hookUrl).pathname };
  }

  const signed = (body: object) => {
    const raw = JSON.stringify(body);
    return { payload: raw, headers: { 'content-type': 'application/json', 'x-acme-signature': createHmac('sha256', SIGNING_SECRET).update(raw).digest('hex') } };
  };

  it('verifies the signature over the raw body and starts one run per event', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path } = await liveAppZap(u);
    const body = { events: [{ id: 'e1', contact: { email: 'one@x.co' } }, { id: 'e2', contact: { email: 'two@x.co' } }] };

    const forged = await hook(path, { payload: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-acme-signature': 'nope' } });
    expect(forged.statusCode).toBe(401);

    const res = await hook(path, signed(body));
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(2);
    const runs = (await u.api.get(`/workspaces/${u.ws}/runs?source=APP_EVENT`)).json().items;
    expect(runs.map((r: { source: string }) => r.source)).toEqual(['APP_EVENT', 'APP_EVENT']);

    // Provider redelivery → same events are not run twice.
    await hook(path, signed(body));
    expect(await ctx.prisma.run.count()).toBe(2);
  });

  it('acknowledges but ignores deliveries for paused zaps', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path, base } = await liveAppZap(u);
    await u.api.post(`${base}/disable`);
    const res = await hook(path, signed({ events: [{ id: 'e1', contact: {} }] }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true, reason: 'zap_inactive' });
    expect(await ctx.prisma.run.count()).toBe(0);
  });
});

describe('runs API', () => {
  it('lists with filters and pagination, scoped to the workspace', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const other = await signUp(ctx, 'b@example.com');
    const { path, zap } = await liveWebhookZap(u);
    for (let i = 0; i < 5; i++) await hook(path, { payload: { i } });
    await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/run`, { payload: { manual: true } });

    const page1 = (await u.api.get(`/workspaces/${u.ws}/runs?limit=4`)).json();
    expect(page1.items).toHaveLength(4);
    expect(page1.items[0].source).toBe('MANUAL');
    const page2 = (await u.api.get(`/workspaces/${u.ws}/runs?limit=4&cursor=${page1.nextCursor}`)).json();
    expect(page2.items).toHaveLength(2);
    expect((await u.api.get(`/workspaces/${u.ws}/runs?source=WEBHOOK`)).json().items).toHaveLength(5);
    expect((await u.api.get(`/workspaces/${u.ws}/runs?zapId=${zap.id}&status=QUEUED`)).json().items).toHaveLength(6);
    expect((await u.api.get(`/workspaces/${u.ws}/runs?status=BOGUS`)).statusCode).toBe(400);

    expect((await other.api.get(`/workspaces/${other.ws}/runs`)).json().items).toHaveLength(0);
    expect((await other.api.get(`/workspaces/${other.ws}/runs/${page1.items[0].id}`)).statusCode).toBe(404);
  });

  it('manual runs use the trigger sample data when no payload is given', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { zap } = await liveWebhookZap(u);
    const { runId } = (await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/run`)).json();
    expect((await u.api.get(`/workspaces/${u.ws}/runs/${runId}`)).json().triggerOutput.body.email).toBe('jane@example.com');
  });

  it('cancels queued runs and removes their job', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path } = await liveWebhookZap(u);
    const { runId } = (await hook(path, { payload: {} })).json();
    const res = await u.api.post(`/workspaces/${u.ws}/runs/${runId}/cancel`);
    expect(res.json().status).toBe('CANCELED');
    expect(await runsQueue.getJob(runId)).toBeUndefined();
    expect((await u.api.post(`/workspaces/${u.ws}/runs/${runId}/cancel`)).statusCode).toBe(409);
  });

  it('replays a failed run from the failed step, reusing successful outputs', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path } = await liveWebhookZap(u);
    const { runId } = (await hook(path, { payload: { email: 'r@x.co' } })).json();
    // Simulate the worker: step1 succeeded, step2 failed.
    await ctx.prisma.$transaction([
      ctx.prisma.run.update({ where: { id: runId }, data: { status: 'FAILED', finishedAt: new Date(), error: { message: 'boom', stepKey: 'step2' } } }),
      ctx.prisma.stepRun.createMany({
        data: [
          { runId, workspaceId: u.ws, stepKey: 'step1', position: 1, appKey: 'acme', operationKey: 'createContact', status: 'SUCCEEDED', output: { id: 'c1', email: 'r@x.co' } },
          { runId, workspaceId: u.ws, stepKey: 'step2', position: 2, appKey: 'acme', operationKey: 'createContact', status: 'FAILED', error: { message: 'boom' } },
        ],
      }),
    ]);

    const replay = await u.api.post(`/workspaces/${u.ws}/runs/${runId}/replay`, { mode: 'from_failed' });
    expect(replay.statusCode).toBe(202);
    const detail = (await u.api.get(`/workspaces/${u.ws}/runs/${replay.json().runId}`)).json();
    expect(detail).toMatchObject({ source: 'REPLAY', replayOfId: runId, status: 'QUEUED', triggerOutput: { body: { email: 'r@x.co' } } });
    expect(detail.steps).toMatchObject([{ stepKey: 'step1', status: 'SUCCEEDED', output: { id: 'c1' } }]);

    const full = (await u.api.post(`/workspaces/${u.ws}/runs/${runId}/replay`, { mode: 'full' })).json();
    expect((await u.api.get(`/workspaces/${u.ws}/runs/${full.runId}`)).json().steps).toEqual([]);
  });

  it('refuses invalid replays', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const { path } = await liveWebhookZap(u);
    const { runId } = (await hook(path, { payload: {} })).json();
    expect((await u.api.post(`/workspaces/${u.ws}/runs/${runId}/replay`, {})).statusCode).toBe(409); // still queued
    await ctx.prisma.run.update({ where: { id: runId }, data: { status: 'SUCCEEDED' } });
    expect((await u.api.post(`/workspaces/${u.ws}/runs/${runId}/replay`, { mode: 'from_failed' })).statusCode).toBe(400);
    expect((await u.api.post(`/workspaces/${u.ws}/runs/${runId}/replay`, { mode: 'full' })).statusCode).toBe(202);
  });
});
