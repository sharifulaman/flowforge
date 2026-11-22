import { SecretBox } from '@flowforge/shared/node';
import type { ZapDefinition, StepDefinition } from '@flowforge/shared';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore, RunExecutor, SafeHttpClient } from '../src';
import { calls, executorRegistry } from './fixtures';
import { prisma, resetDb, seedZap } from './helpers';

const registry = executorRegistry();
const credentials = new CredentialStore(prisma, new SecretBox({ 1: randomBytes(32) }, 1), registry);
const fakeSandbox = { run: async () => ({ result: null, logs: [] }) };
const http = new SafeHttpClient();
let clock = Date.now();
const executor = new RunExecutor({ prisma, registry, credentials, http, sandbox: fakeSandbox, now: () => clock });

beforeEach(async () => {
  await resetDb();
  for (const k of Object.keys(calls)) delete calls[k];
  clock = Date.now();
});
afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

const step = (key: string, operationKey: string, config: Record<string, unknown> = {}, extra: Partial<StepDefinition> = {}): StepDefinition => ({
  key,
  name: null,
  appKey: 'testkit',
  operationKey,
  connectionId: null,
  config,
  timeoutMs: null,
  ...extra,
});

async function createRun(steps: StepDefinition[], triggerOutput: unknown = { body: { email: 'Ada@Example.com', n: 21 } }) {
  const { workspace, zap, user } = await seedZap();
  const definition: ZapDefinition = {
    schemaVersion: 1,
    trigger: { key: 'trigger', name: null, appKey: 'webhook', operationKey: 'catchHook', connectionId: null, config: {}, timeoutMs: null },
    steps,
  };
  const version = await prisma.zapVersion.create({ data: { zapId: zap.id, workspaceId: workspace.id, version: 2, createdById: user.id, definition: definition as never } });
  const run = await prisma.run.create({
    data: { workspaceId: workspace.id, zapId: zap.id, zapVersionId: version.id, source: 'WEBHOOK', idempotencyKey: `k${Math.random()}`, triggerOutput: triggerOutput as never },
  });
  return { runId: run.id, workspace, zap };
}

const runRow = (id: string) => prisma.run.findUniqueOrThrow({ where: { id }, include: { steps: { orderBy: { position: 'asc' } } } });
const once = { attempt: 1, maxAttempts: 5 };

describe('RunExecutor — happy path & data mapping', () => {
  it('runs steps in order, mapping outputs through templates (type-preserving)', async () => {
    const { runId } = await createRun([
      step('step1', 'echo', { email: '{{ trigger.body.email | lower }}', n: '{{ trigger.body.n }}' }),
      step('step2', 'typed', { n: '{{ step1.n }}' }),
      step('step3', 'echo', { summary: 'Doubled {{ step2.doubled }} for {{ step1.email }}', missing: '{{ step1.nope }}' }),
    ]);
    expect(await executor.execute(runId, once)).toEqual({ status: 'SUCCEEDED' });

    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', attempts: 1, error: null });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.steps.map((s) => [s.stepKey, s.status, s.position])).toEqual([
      ['step1', 'SUCCEEDED', 1],
      ['step2', 'SUCCEEDED', 2],
      ['step3', 'SUCCEEDED', 3],
    ]);
    expect(run.steps[0]!.output).toMatchObject({ email: 'ada@example.com', n: 21, idempotencyKey: `${runId}:step1`, isTest: false });
    expect(run.steps[1]!.input).toEqual({ n: 21, label: 'none' }); // schema default applied
    expect(run.steps[1]!.output).toEqual({ doubled: 42, label: 'none' });
    expect(run.steps[2]!.output).toMatchObject({ summary: 'Doubled 42 for ada@example.com' });
    // A whole-value template with a missing path resolves to undefined → the key is omitted.
    expect(run.steps[2]!.output).not.toHaveProperty('missing');
    expect(run.steps[2]!.logs).toEqual([expect.objectContaining({ level: 'warn', message: 'No value for {{ step1.nope }} — used empty value' })]);
  });

  it('captures connector logs and normalizes undefined output', async () => {
    const { runId } = await createRun([step('step1', 'logs'), step('step2', 'nothing')]);
    await executor.execute(runId, once);
    const run = await runRow(runId);
    expect(run.steps[0]!.logs).toEqual([
      expect.objectContaining({ level: 'info', message: 'hello', data: { a: 1 } }),
      expect.objectContaining({ level: 'warn', message: 'careful' }),
    ]);
    expect(run.steps[1]!.output).toEqual({});
  });
});

describe('RunExecutor — failures', () => {
  it('fails fast on fatal errors without retrying', async () => {
    const { runId } = await createRun([step('step1', 'echo'), step('step2', 'boom'), step('step3', 'echo')]);
    expect(await executor.execute(runId, once)).toEqual({ status: 'FAILED', error: { message: 'bad request: 400', code: 'HTTP_400', stepKey: 'step2' } });
    const run = await runRow(runId);
    expect(run.status).toBe('FAILED');
    expect(run.steps.map((s) => s.status)).toEqual(['SUCCEEDED', 'FAILED']); // step3 never ran
    expect(run.finishedAt).not.toBeNull();
  });

  it('treats unexpected exceptions (bugs) as fatal', async () => {
    const { runId } = await createRun([step('step1', 'crash')]);
    const out = await executor.execute(runId, once);
    expect(out).toMatchObject({ status: 'FAILED', error: { code: 'STEP_ERROR', message: expect.stringMatching(/Cannot read properties/) } });
  });

  it('fails on invalid resolved input with field details', async () => {
    const { runId } = await createRun([step('step1', 'typed', { n: '{{ trigger.body.email }}' })]);
    const out = await executor.execute(runId, once);
    expect(out).toMatchObject({ status: 'FAILED', error: { code: 'INVALID_INPUT', message: 'Invalid input: n must be number' } });
    expect((await runRow(runId)).steps[0]!.input).toEqual({ n: 'Ada@Example.com' });
  });

  it('rejects oversized outputs', async () => {
    const { runId } = await createRun([step('step1', 'big')]);
    expect(await executor.execute(runId, once)).toMatchObject({ status: 'FAILED', error: { code: 'OUTPUT_TOO_LARGE' } });
  });

  it('flags the connection when a step hits an auth error', async () => {
    const { runId, workspace } = await createRun([]);
    const conn = await prisma.connection.create({
      data: { workspaceId: workspace.id, appKey: 'testkit', name: 'c', authType: 'CUSTOM', createdById: 'u', ...credentials.encrypt(workspace.id, 'testkit', {}) },
    });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { zapVersion: true } });
    const def = run.zapVersion.definition as unknown as ZapDefinition;
    def.steps = [step('step1', 'authFail', {}, { connectionId: conn.id })];
    await prisma.zapVersion.update({ where: { id: run.zapVersionId }, data: { definition: def as never } });

    expect(await executor.execute(runId, once)).toMatchObject({ status: 'FAILED', error: { code: 'AUTH_FAILED' } });
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe('ERROR');
  });
});

describe('RunExecutor — retries & checkpointing', () => {
  it('asks for a retry on transient errors, then resumes at the failed step', async () => {
    const { runId } = await createRun([
      step('step1', 'echo', { a: 1 }),
      step('step2', 'flaky', { times: 2, key: 'r1' }),
      step('step3', 'echo', { prev: '{{ step2.succeededOnCall }}' }),
    ]);

    const first = await executor.execute(runId, { attempt: 1, maxAttempts: 5 });
    expect(first).toEqual({ status: 'RETRY', error: { message: 'flaky failure #1', code: 'RETRYABLE', stepKey: 'step2' }, retryAfterMs: 5_000 });
    let run = await runRow(runId);
    expect(run.status).toBe('WAITING');
    expect(run.error).toMatchObject({ willRetry: true, stepKey: 'step2' });

    expect((await executor.execute(runId, { attempt: 2, maxAttempts: 5 })).status).toBe('RETRY');
    expect(await executor.execute(runId, { attempt: 3, maxAttempts: 5 })).toEqual({ status: 'SUCCEEDED' });

    run = await runRow(runId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', attempts: 3, error: null });
    expect(run.steps.map((s) => [s.stepKey, s.attempts])).toEqual([
      ['step1', 1], // checkpointed: executed exactly once across 3 attempts
      ['step2', 3],
      ['step3', 1],
    ]);
    expect(calls.echo).toBe(2); // step1 + step3, never re-run
    expect(run.steps[2]!.output).toMatchObject({ prev: 3 });
  });

  it('gives up after the last attempt', async () => {
    const { runId } = await createRun([step('step1', 'flaky', { times: 99, key: 'r2' })]);
    const out = await executor.execute(runId, { attempt: 3, maxAttempts: 3 });
    expect(out).toMatchObject({ status: 'FAILED', error: { message: 'flaky failure #1 (gave up after 3 attempts)' } });
    expect((await runRow(runId)).status).toBe('FAILED');
  });

  it('is idempotent for duplicate deliveries of a finished run', async () => {
    const { runId } = await createRun([step('step1', 'echo')]);
    await executor.execute(runId, once);
    expect(await executor.execute(runId, once)).toEqual({ status: 'ALREADY_DONE' });
    expect(calls.echo).toBe(1);
    expect(await executor.execute('missing-run-id', once)).toEqual({ status: 'NOT_FOUND' });
  });
});

describe('RunExecutor — timeouts', () => {
  it('times out steps that honour the abort signal (retryable)', async () => {
    const { runId } = await createRun([step('step1', 'slow')]);
    const t0 = Date.now();
    const out = await executor.execute(runId, once);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(out).toMatchObject({ status: 'RETRY', error: { message: 'Step timed out after 1s' } });
  });

  it('times out steps that ignore the signal', async () => {
    const { runId } = await createRun([step('step1', 'hang')]);
    const out = await executor.execute(runId, once);
    expect(out).toMatchObject({ status: 'RETRY', error: { message: 'Step timed out after 1s' } });
  });

  it('honours per-step timeout overrides (clamped to ≥1s)', async () => {
    const { runId } = await createRun([step('step1', 'slow', {}, { timeoutMs: 1_500 })]);
    const t0 = Date.now();
    await executor.execute(runId, once);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
  });

  it('converts worker shutdown into a retry', async () => {
    const { runId } = await createRun([step('step1', 'slow')]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    expect(await executor.execute(runId, { ...once, signal: ctrl.signal })).toMatchObject({ status: 'RETRY', error: { message: expect.stringMatching(/shutting down/) } });
  });
});

describe('RunExecutor — filter, delay, cancel', () => {
  it('stops the run as FILTERED and skips remaining steps', async () => {
    const { ConnectorRegistry, defineApp, objectSchema, StopRun } = await import('@flowforge/connector-sdk');
    const filterKit = defineApp({
      key: 'filterkit',
      name: 'Filter kit',
      description: 'x',
      category: 'developer',
      icon: 'Filter',
      color: '#000000',
      auth: { type: 'none' },
      actions: [
        {
          key: 'onlyVip',
          name: 'Only VIP',
          description: 'Stops unless vip',
          input: objectSchema({ vip: { type: 'boolean' } }, ['vip']),
          run: async ({ input }) => {
            if (!input.vip) throw new StopRun('Customer is not VIP');
            return { passed: true };
          },
        },
      ],
    });
    const reg = new ConnectorRegistry([...executorRegistry().all(), filterKit]);
    const exec = new RunExecutor({ prisma, registry: reg, credentials, http, sandbox: fakeSandbox });
    const { runId } = await createRun(
      [step('step1', 'echo'), { ...step('step2', 'onlyVip', { vip: '{{ trigger.body.vip }}' }), appKey: 'filterkit' }, step('step3', 'echo')],
      { body: { vip: false } },
    );
    expect(await exec.execute(runId, once)).toEqual({ status: 'FILTERED', reason: 'Customer is not VIP', stepKey: 'step2' });
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'FILTERED', error: { code: 'FILTERED', message: 'Customer is not VIP' } });
    expect(run.steps.map((s) => s.status)).toEqual(['SUCCEEDED', 'FILTERED']);
    expect(calls.echo).toBe(1);
  });

  it('suspends on Delay and completes the delay step on resume', async () => {
    const { runId } = await createRun([step('step1', 'wait', { ms: 60_000 }), step('step2', 'echo', { after: '{{ step1.delayedUntil }}' })]);
    const out = await executor.execute(runId, once);
    expect(out.status).toBe('SUSPENDED');
    const resumeAt = (out as { resumeAt: number }).resumeAt;
    expect(resumeAt - clock).toBeGreaterThan(55_000);
    expect((await runRow(runId)).status).toBe('WAITING');

    // Early wake-up → suspend again for the remaining time, no re-execution.
    clock += 10_000;
    expect(await executor.execute(runId, once)).toEqual({ status: 'SUSPENDED', resumeAt });

    clock = resumeAt + 5;
    expect(await executor.execute(runId, once)).toEqual({ status: 'SUCCEEDED' });
    const run = await runRow(runId);
    expect(calls.wait).toBe(1);
    expect(run.steps[0]).toMatchObject({ status: 'SUCCEEDED', output: { delayedUntil: new Date(resumeAt).toISOString() } });
    expect(run.steps[1]!.output).toMatchObject({ after: new Date(resumeAt).toISOString() });
  });

  it('stops between steps when the run is canceled', async () => {
    const { runId } = await createRun([step('step1', 'wait', { ms: 1_000 }), step('step2', 'echo')]);
    await executor.execute(runId, once);
    await prisma.run.update({ where: { id: runId }, data: { status: 'CANCELED' } });
    clock += 5_000;
    expect(await executor.execute(runId, once)).toEqual({ status: 'CANCELED' });
    expect(calls.echo).toBeUndefined();
  });

  it('a cancel arriving while the last step runs wins over completion', async () => {
    const { ConnectorRegistry, defineApp, objectSchema } = await import('@flowforge/connector-sdk');
    const selfCancel = defineApp({
      key: 'cancelkit',
      name: 'Cancel kit',
      description: 'x',
      category: 'developer',
      icon: 'X',
      color: '#000000',
      auth: { type: 'none' },
      actions: [
        {
          key: 'cancelMe',
          name: 'Cancel me',
          description: 'Cancels its own run mid-step (like a user clicking Cancel)',
          input: objectSchema({}),
          run: async ({ runId }) => {
            await prisma.run.update({ where: { id: runId }, data: { status: 'CANCELED' } });
            return { ok: true };
          },
        },
      ],
    });
    const exec = new RunExecutor({ prisma, registry: new ConnectorRegistry([selfCancel]), credentials, http, sandbox: fakeSandbox });
    const { runId } = await createRun([{ ...step('step1', 'cancelMe'), appKey: 'cancelkit' }]);
    await exec.execute(runId, once);
    expect((await runRow(runId)).status).toBe('CANCELED');
  });
});
