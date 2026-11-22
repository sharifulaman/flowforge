import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bucketStarts, StatsService } from '../src/modules/stats/stats.service';
import { createTestApp, resetState, signUp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

async function seed(ws: string, userId: string, name: string) {
  const zap = await ctx.prisma.zap.create({ data: { workspaceId: ws, name, createdById: userId, status: 'ACTIVE' } });
  const version = await ctx.prisma.zapVersion.create({
    data: {
      zapId: zap.id,
      workspaceId: ws,
      version: 1,
      createdById: userId,
      definition: { schemaVersion: 1, trigger: { key: 'trigger', name: null, appKey: 'webhook', operationKey: 'catchHook', connectionId: null, config: {}, timeoutMs: null }, steps: [{ key: 'step1', name: 'Notify', appKey: 'oauthy', operationKey: 'ping', connectionId: null, config: {}, timeoutMs: null }] },
    },
  });
  let n = 0;
  const run = (status: string, hoursAgo: number, durationMs: number | null = null, error: object | null = null) =>
    ctx.prisma.run.create({
      data: {
        workspaceId: ws,
        zapId: zap.id,
        zapVersionId: version.id,
        source: 'WEBHOOK',
        idempotencyKey: `k${n++}`,
        triggerOutput: {},
        status: status as never,
        durationMs,
        error: error ?? undefined,
        queuedAt: new Date(Date.now() - hoursAgo * 3_600_000),
      },
    });
  return { zap, version, run };
}

describe('GET /workspaces/:id/stats', () => {
  it('computes totals, percentiles, series, previous period and top failing zaps', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const a = await seed(u.ws, u.userId, 'Leads → Slack');
    const b = await seed(u.ws, u.userId, 'Invoices');
    // Current 24h window
    for (const d of [100, 200, 300, 400, 1000]) await a.run('SUCCEEDED', 1, d);
    await a.run('FAILED', 2, 50, { message: 'Slack: channel_not_found' });
    await b.run('FAILED', 3, 10, { message: 'old' });
    await b.run('FAILED', 1.5, 10, { message: 'Google API: quota' });
    await b.run('FILTERED', 5, 5);
    await b.run('RUNNING', 0.1);
    // Previous 24h window
    await a.run('SUCCEEDED', 30, 100);
    await a.run('FAILED', 40, 100);
    // Outside both windows
    await a.run('FAILED', 100, 100);

    const res = await u.api.get(`/workspaces/${u.ws}/stats?range=24h`);
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.bucket).toBe('hour');
    expect(s.totals).toEqual({
      total: 10,
      succeeded: 5,
      failed: 3,
      filtered: 1,
      canceled: 0,
      inProgress: 1,
      successRate: 5 / 8,
      p50DurationMs: 300,
      p95DurationMs: 880, // percentile_cont over [100,200,300,400,1000]
    });
    expect(s.previous).toEqual({ total: 2, failed: 1, successRate: 0.5 });
    expect(s.series.length).toBeGreaterThanOrEqual(24);
    const sum = s.series.reduce((acc: number, x: any) => acc + x.succeeded + x.failed + x.filtered + x.other, 0);
    expect(sum).toBe(10);
    expect(s.topFailing).toEqual([
      expect.objectContaining({ zapId: b.zap.id, name: 'Invoices', failed: 2, lastError: 'Google API: quota' }),
      expect.objectContaining({ zapId: a.zap.id, name: 'Leads → Slack', failed: 1, lastError: 'Slack: channel_not_found' }),
    ]);
    expect(s.zaps).toEqual({ active: 2, error: 0, total: 2 });

    const week = (await u.api.get(`/workspaces/${u.ws}/stats?range=7d`)).json();
    expect(week.bucket).toBe('day');
    expect(week.totals.total).toBe(13); // the 100h-old run is inside 7 days
    expect((await u.api.get(`/workspaces/${u.ws}/stats?range=1y`)).statusCode).toBe(400);
  });

  it('is scoped to the workspace', async () => {
    const a = await signUp(ctx, 'a@example.com');
    const b = await signUp(ctx, 'b@example.com');
    const z = await seed(a.ws, a.userId, 'A');
    await z.run('FAILED', 1, 10, { message: 'x' });
    const bs = (await b.api.get(`/workspaces/${b.ws}/stats?range=24h`)).json();
    expect(bs.totals.total).toBe(0);
    expect(bs.totals.successRate).toBeNull();
    expect(bs.topFailing).toEqual([]);
    expect((await b.api.get(`/workspaces/${a.ws}/stats`)).statusCode).toBe(404);
  });

  it('places runs in the right UTC bucket and keeps empty buckets', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const z = await seed(u.ws, u.userId, 'Z');
    const now = new Date('2026-06-10T12:30:00Z');
    const at = (iso: string, status = 'SUCCEEDED') =>
      ctx.prisma.run.create({ data: { workspaceId: u.ws, zapId: z.zap.id, zapVersionId: z.version.id, source: 'MANUAL', idempotencyKey: iso + status, triggerOutput: {}, status: status as never, queuedAt: new Date(iso) } });
    await at('2026-06-10T11:05:00Z');
    await at('2026-06-10T11:55:00Z', 'FAILED');
    await at('2026-06-09T13:00:00Z', 'CANCELED');
    const stats = await ctx.app.get(StatsService).get(u.ws, '24h', now);
    const b11 = stats.series.find((x) => x.start === '2026-06-10T11:00:00.000Z');
    expect(b11).toMatchObject({ succeeded: 1, failed: 1 });
    expect(stats.series.find((x) => x.start === '2026-06-09T13:00:00.000Z')).toMatchObject({ other: 1 });
    expect(stats.series.find((x) => x.start === '2026-06-10T05:00:00.000Z')).toMatchObject({ succeeded: 0, failed: 0, filtered: 0, other: 0 });
    expect(bucketStarts(new Date('2026-06-01T10:20:00Z'), new Date('2026-06-03T00:00:00Z'), 'day').map((d) => d.toISOString())).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
      '2026-06-03T00:00:00.000Z',
    ]);
  });
});

describe('run detail plan', () => {
  it('includes the planned steps of the executed version', async () => {
    const u = await signUp(ctx, 'a@example.com');
    const z = await seed(u.ws, u.userId, 'Z');
    const run = await z.run('FAILED', 1);
    const detail = (await u.api.get(`/workspaces/${u.ws}/runs/${run.id}`)).json();
    expect(detail.plan).toEqual({
      trigger: { key: 'trigger', name: null, appKey: 'webhook', operationKey: 'catchHook' },
      steps: [{ key: 'step1', name: 'Notify', appKey: 'oauthy', operationKey: 'ping' }],
    });
  });
});
