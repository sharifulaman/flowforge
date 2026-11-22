import { QUEUES, type TestStepJobData, type TestStepResult } from '@flowforge/shared';
import { type Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, signUp, type TestContext } from './helpers';

let ctx: TestContext;
let worker: Worker<TestStepJobData, TestStepResult> | null = null;
const received: TestStepJobData[] = [];

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await worker?.close();
  await ctx.close();
});
beforeEach(async () => {
  await worker?.close();
  worker = null;
  received.length = 0;
  await resetState(ctx);
});

/** Stand-in for the real worker (covered by apps/worker tests): echoes a canned result. */
async function startFakeWorker(handler: (job: Job<TestStepJobData>) => Promise<TestStepResult>) {
  worker = new Worker<TestStepJobData, TestStepResult>(QUEUES.testStep, handler, {
    connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
  });
  await worker.waitUntilReady();
}

async function zapWithStep(u: Awaited<ReturnType<typeof signUp>>) {
  const zap = (await u.api.post(`/workspaces/${u.ws}/zaps`, { name: 'Z' })).json();
  const detail = (await u.api.post(`/workspaces/${u.ws}/zaps/${zap.id}/steps`, { appKey: 'oauthy', operationKey: 'ping' })).json();
  return { zapId: zap.id as string, stepId: detail.steps[0].id as string };
}

describe('POST /zaps/:id/steps/:stepId/test', () => {
  it('enqueues a test job and returns the worker’s result', async () => {
    await startFakeWorker(async (job) => {
      received.push(job.data);
      return { status: 'success', input: { a: 1 }, output: { pong: true }, error: null, logs: [], durationMs: 12 };
    });
    const u = await signUp(ctx, 'a@example.com');
    const { zapId, stepId } = await zapWithStep(u);
    const res = await u.api.post(`/workspaces/${u.ws}/zaps/${zapId}/steps/${stepId}/test`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'success', output: { pong: true } });
    expect(received).toEqual([{ workspaceId: u.ws, zapId, stepId }]);
  });

  it('is tenant-scoped (404 before anything is enqueued)', async () => {
    await startFakeWorker(async (job) => {
      received.push(job.data);
      return { status: 'success', input: null, output: {}, error: null, logs: [], durationMs: 1 };
    });
    const a = await signUp(ctx, 'a@example.com');
    const b = await signUp(ctx, 'b@example.com');
    const { zapId, stepId } = await zapWithStep(a);
    expect((await b.api.post(`/workspaces/${b.ws}/zaps/${zapId}/steps/${stepId}/test`)).statusCode).toBe(404);
    expect(received).toEqual([]);
  });

  it('maps worker crashes to 502', async () => {
    await startFakeWorker(async () => {
      throw new Error('kaboom');
    });
    const u = await signUp(ctx, 'a@example.com');
    const { zapId, stepId } = await zapWithStep(u);
    const res = await u.api.post(`/workspaces/${u.ws}/zaps/${zapId}/steps/${stepId}/test`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/kaboom/);
  });
});
