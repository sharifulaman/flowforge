import { RetryableError, StopRun, SuspendRun, validateConfig, validateInput } from '@flowforge/connector-sdk';
import { SafeHttpClient } from '@flowforge/safe-http';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT_IN_APPS, createDefaultRegistry, nextRuns, validateCron } from '../src';
import { evaluate } from '../src/core/filter-ops';
import { actionCtx } from './harness';

const reg = createDefaultRegistry({});
const action = (app: string, key: string) => reg.getAction(app, key)!;

describe('registry', () => {
  it('loads every built-in app (definitions validated at import)', () => {
    expect(reg.all().map((a) => a.key)).toEqual(['webhook', 'schedule', 'http', 'filter', 'delay', 'code', 'smtp', 'slack', 'google-sheets', 'telegram', 'rss']);
    expect(BUILT_IN_APPS.flatMap((a) => [...a.triggers, ...a.actions]).length).toBeGreaterThanOrEqual(12);
    // OAuth apps report availability from env.
    expect(reg.manifests().find((m) => m.key === 'google-sheets')!.auth.available).toBe(false);
    expect(createDefaultRegistry({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }).manifests().find((m) => m.key === 'google-sheets')!.auth.available).toBe(true);
  });

  it('every sampleOutput is a JSON object (the field picker relies on it)', () => {
    for (const app of BUILT_IN_APPS) {
      for (const op of [...app.triggers, ...app.actions]) {
        expect(op.sampleOutput, `${app.key}.${op.key}`).toBeTypeOf('object');
      }
    }
  });
});

describe('schedule trigger', () => {
  const trigger = reg.getTrigger('schedule', 'every');
  if (trigger?.kind !== 'schedule') throw new Error('schedule trigger missing');

  it('maps config to a repeat spec and validates cron/timezone', () => {
    expect(trigger.schedule({ mode: 'interval', intervalMinutes: 5 })).toEqual({ everyMs: 300_000 });
    expect(trigger.schedule({ mode: 'cron', cron: ' 0 9 * * 1-5 ', timezone: 'Europe/Berlin' })).toEqual({ cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' });
    expect(trigger.validate!({ mode: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' })).toEqual([]);
    expect(trigger.validate!({ mode: 'cron' })).toEqual([{ field: 'cron', message: 'This field is required' }]);
    expect(trigger.validate!({ mode: 'cron', cron: '* * * * * *' })[0]!.message).toMatch(/5-field/);
    expect(trigger.validate!({ mode: 'interval', timezone: 'Mars/Olympus' })[0]).toMatchObject({ field: 'timezone' });
  });

  it('computes next runs in a timezone', () => {
    const runs = nextRuns('0 9 * * 1-5', 'America/New_York', 2, new Date('2026-03-02T00:00:00Z'));
    expect(runs.map((d) => d.toISOString())).toEqual(['2026-03-02T14:00:00.000Z', '2026-03-03T14:00:00.000Z']);
    expect(validateCron('*/5 * * * *')).toBeNull();
  });
});

describe('HTTP Request (real SSRF-safe client against a local server)', () => {
  let server: Server;
  let base: string;
  const http = new SafeHttpClient({ allowHosts: ['127.0.0.1'] });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url?.startsWith('/fail')) return res.writeHead(422, { 'content-type': 'application/json' }).end('{"error":"bad"}');
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ method: req.method, url: req.url, ct: req.headers['content-type'] ?? null, auth: req.headers.authorization ?? null, body }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await http.close();
  });

  const run = (input: Record<string, unknown>, client = http) => {
    const v = validateInput(action('http', 'request').input, input);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    return action('http', 'request').run(actionCtx({ input: v.value, http: client })) as Promise<{ status: number; body: any }>;
  };

  it('sends JSON, form and raw bodies with headers and query', async () => {
    const json = await run({ method: 'POST', url: `${base}/x`, query: { page: '2' }, headers: { Authorization: 'Bearer t' }, bodyType: 'json', body: { a: 1 } });
    expect(json.status).toBe(200);
    expect(json.body).toMatchObject({ method: 'POST', url: '/x?page=2', ct: 'application/json', auth: 'Bearer t', body: '{"a":1}' });

    const jsonString = await run({ method: 'POST', url: `${base}/x`, bodyType: 'json', body: '{"from":"template"}' });
    expect(jsonString.body.body).toBe('{"from":"template"}');

    const form = await run({ method: 'POST', url: `${base}/x`, bodyType: 'form', body: { name: 'Ada', n: 3 } });
    expect(form.body).toMatchObject({ ct: 'application/x-www-form-urlencoded', body: 'name=Ada&n=3' });

    const raw = await run({ method: 'PUT', url: `${base}/x`, bodyType: 'raw', body: 'hello' });
    expect(raw.body).toMatchObject({ method: 'PUT', ct: 'text/plain; charset=utf-8', body: 'hello' });
  });

  it('fails on 4xx by default, or returns the response when failOnError is off', async () => {
    await expect(run({ method: 'GET', url: `${base}/fail` })).rejects.toMatchObject({ code: 'HTTP_422' });
    expect(await run({ method: 'GET', url: `${base}/fail`, failOnError: false })).toMatchObject({ status: 422, body: { error: 'bad' } });
  });

  it('refuses private targets in production configuration', async () => {
    const strict = new SafeHttpClient();
    await expect(run({ method: 'GET', url: `${base}/x` }, strict)).rejects.toThrow(/blocked/);
    await expect(run({ method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' }, strict)).rejects.toThrow(/blocked/);
    await strict.close();
  });
});

describe('Delay', () => {
  const delay = action('delay', 'wait');

  it('suspends for a duration or until a date', async () => {
    const t0 = Date.now();
    const err: any = await delay.run(actionCtx({ input: { mode: 'for', amount: 2, unit: 'hours' } })).catch((e: any) => e);
    expect(err).toBeInstanceOf(SuspendRun);
    expect(err.resumeAt.getTime() - t0).toBeGreaterThanOrEqual(2 * 3_600_000 - 50);

    const until = new Date(Date.now() + 86_400_000).toISOString();
    const err2: any = await delay.run(actionCtx({ input: { mode: 'until', until } })).catch((e: any) => e);
    expect(err2.resumeAt.toISOString()).toBe(until);
  });

  it('continues immediately for past dates, refuses > 30 days and bad dates', async () => {
    expect(await delay.run(actionCtx({ input: { mode: 'until', until: '2000-01-01T00:00:00Z' } }))).toMatchObject({ skipped: true });
    await expect(delay.run(actionCtx({ input: { mode: 'for', amount: 31, unit: 'days' } }))).rejects.toMatchObject({ code: 'DELAY_TOO_LONG' });
    await expect(delay.run(actionCtx({ input: { mode: 'until', until: 'tomorrow-ish' } }))).rejects.toMatchObject({ code: 'INVALID_DATE' });
    expect(delay.validate!({ mode: 'until' })).toEqual([{ field: 'until', message: 'This field is required' }]);
  });

  it('does not wait in test mode', async () => {
    expect(await delay.run(actionCtx({ input: { mode: 'for', amount: 5, unit: 'minutes' }, isTest: true }))).toMatchObject({ testMode: true });
  });
});

describe('Filter', () => {
  const filter = action('filter', 'onlyContinueIf');

  it.each([
    [{ left: 'VIP', operator: 'equals', right: 'vip' }, true],
    [{ left: 'VIP', operator: 'equals', right: 'vip', caseSensitive: true }, false],
    [{ left: '10', operator: 'equals', right: 10 }, true],
    [{ left: 10, operator: 'greater_than', right: '9.5' }, true],
    [{ left: '2026-02-01', operator: 'less_than', right: '2026-03-01T00:00:00Z' }, true],
    [{ left: 'abc', operator: 'greater_than', right: 'xyz' }, false],
    [{ left: 'hello world', operator: 'contains', right: 'WORLD' }, true],
    [{ left: ['a', 'B'], operator: 'contains', right: 'b' }, true],
    [{ left: 'hello', operator: 'not_contains', right: 'x' }, true],
    [{ left: 'invoice-42', operator: 'starts_with', right: 'invoice' }, true],
    [{ left: 'a.pdf', operator: 'ends_with', right: '.PDF' }, true],
    [{ left: '  ', operator: 'is_empty' }, true],
    [{ left: [], operator: 'is_empty' }, true],
    [{ left: { a: 1 }, operator: 'is_not_empty' }, true],
    [{ left: 'yes', operator: 'is_true' }, true],
    [{ left: 0, operator: 'is_false' }, true],
    [{ left: 'order #123', operator: 'matches_regex', right: '#\\d+$' }, true],
  ] as const)('%j → %s', (cond, expected) => {
    expect(evaluate(cond as never)).toBe(expected);
  });

  it('passes with all/any semantics and stops the run otherwise', async () => {
    const conds = [
      { left: 'pro', operator: 'equals', right: 'pro' },
      { left: 5, operator: 'greater_than', right: 10 },
    ];
    await expect(filter.run(actionCtx({ input: { match: 'all', conditions: conds } }))).rejects.toBeInstanceOf(StopRun);
    const err: any = await filter.run(actionCtx({ input: { match: 'all', conditions: conds } })).catch((e: any) => e);
    expect(err.reason).toBe('Filter did not pass: 5 greater than 10');
    expect(await filter.run(actionCtx({ input: { match: 'any', conditions: conds } }))).toEqual({ passed: true, matched: ['"pro" equals "pro"'] });
  });

  it('rejects oversized regexes and validates config shape', async () => {
    await expect(filter.run(actionCtx({ input: { match: 'all', conditions: [{ left: 'x', operator: 'matches_regex', right: 'a'.repeat(300) }] } }))).rejects.toMatchObject({ code: 'INVALID_CONDITION' });
    expect(validateConfig(filter.input, { conditions: [{ left: '{{ trigger.plan }}', operator: 'equals', right: 'pro' }] })).toEqual([]);
    expect(validateConfig(filter.input, { conditions: [{ left: 'x', operator: 'nope' }] }).map((i) => i.field)).toEqual(['conditions.0.operator']);
  });
});

describe('Code', () => {
  const code = action('code', 'runJavascript');

  it('runs in the provided sandbox, forwards logs and wraps non-object results', async () => {
    const calls: unknown[] = [];
    const sandbox = {
      run: async (src: string, input: Record<string, unknown>) => {
        calls.push({ src, input });
        return { result: [1, 2], logs: [{ level: 'log' as const, message: 'hi' }] };
      },
    };
    const logs: Array<{ level: string; message: string }> = [];
    const out = await code.run(actionCtx({ input: { code: 'return [1,2]', inputData: { n: 1 } }, sandbox, logs }));
    expect(out).toEqual({ result: [1, 2] });
    expect(calls).toEqual([{ src: 'return [1,2]', input: { n: 1 } }]);
    expect(logs).toEqual([{ level: 'info', message: 'hi' }]);
  });

  it('propagates sandbox errors (e.g. timeouts) unchanged', async () => {
    const sandbox = { run: async () => Promise.reject(new RetryableError('x')) };
    await expect(code.run(actionCtx({ input: { code: 'x' }, sandbox }))).rejects.toBeInstanceOf(RetryableError);
  });
});
