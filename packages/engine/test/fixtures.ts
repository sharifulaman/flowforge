import { ConnectorRegistry, defineApp, objectSchema, StopRun } from '@flowforge/connector-sdk';
import { BUILT_IN_APPS } from '@flowforge/connectors';

export const subscribeCalls: Array<{ webhookUrl: string; input: unknown; auth: unknown }> = [];
export const unsubscribeCalls: unknown[] = [];
export let failSubscribe = false;
export const setFailSubscribe = (v: boolean) => (failSubscribe = v);

/** Test app exercising api-key auth, OAuth, actions and an app-webhook trigger. */
export const testApp = defineApp({
  key: 'acme',
  name: 'Acme',
  description: 'Test app',
  category: 'productivity',
  icon: 'Box',
  color: '#000000',
  auth: { type: 'api_key', fields: objectSchema({ apiKey: { type: 'string', 'x-ui': { widget: 'password' } } }, ['apiKey']) },
  triggers: [
    {
      key: 'newThing',
      name: 'New thing',
      description: 'App event',
      kind: 'app_webhook',
      input: objectSchema({ channel: { type: 'string' } }, ['channel']),
      async subscribe(ctx) {
        if (failSubscribe) throw new Error('provider down');
        subscribeCalls.push({ webhookUrl: ctx.webhookUrl, input: ctx.input, auth: ctx.auth });
        return { hookId: 'h-1' };
      },
      async unsubscribe(_ctx, sub) {
        unsubscribeCalls.push(sub);
      },
      parse: (req) => [{ id: 'x', data: req.body as Record<string, unknown> }],
    },
    {
      key: 'poller',
      name: 'Poller',
      description: 'Polling',
      kind: 'polling',
      intervalSeconds: 120,
      input: objectSchema({}),
      poll: async () => ({ items: [] }),
    },
  ],
  actions: [
    {
      key: 'send',
      name: 'Send',
      description: 'Send a thing',
      input: objectSchema({ to: { type: 'string', format: 'email' }, count: { type: 'integer' } }, ['to']),
      run: async ({ input }) => input,
    },
    {
      key: 'stop',
      name: 'Stop',
      description: 'Stops',
      input: objectSchema({}),
      run: async () => {
        throw new StopRun('stopped');
      },
    },
  ],
});

export const oauthApp = defineApp({
  key: 'oauthy',
  name: 'OAuthy',
  description: 'OAuth test app',
  category: 'productivity',
  icon: 'Box',
  color: '#000000',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://auth.oauthy.test/authorize',
    tokenUrl: 'https://auth.oauthy.test/token',
    scopes: ['read', 'write'],
    clientIdEnv: 'OAUTHY_CLIENT_ID',
    clientSecretEnv: 'OAUTHY_CLIENT_SECRET',
    authorizeParams: { access_type: 'offline' },
  },
  actions: [{ key: 'ping', name: 'Ping', description: 'Ping', input: objectSchema({}), run: async () => ({ ok: true }) }],
});

export const OAUTH_ENV = { OAUTHY_CLIENT_ID: 'cid', OAUTHY_CLIENT_SECRET: 'csecret' };

export function testRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([...BUILT_IN_APPS, testApp, oauthApp], OAUTH_ENV);
}

// ─── Executor test kit ─────────────────────────────────────

import { AuthError as _AuthError, FatalError as _FatalError, RetryableError as _RetryableError, SuspendRun as _SuspendRun } from '@flowforge/connector-sdk';

export const calls: Record<string, number> = {};
const bump = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
export const pollState: { items: Array<{ id: string; data: Record<string, unknown> }>; cursorsSeen: unknown[]; fail?: 'auth' | 'net' } = {
  items: [],
  cursorsSeen: [],
};

export const testkit = defineApp({
  key: 'testkit',
  name: 'Test kit',
  description: 'Executor fixtures',
  category: 'developer',
  icon: 'FlaskConical',
  color: '#000000',
  auth: { type: 'none' },
  triggers: [
    {
      key: 'poll',
      name: 'Poll',
      description: 'Polling fixture',
      kind: 'polling',
      intervalSeconds: 60,
      input: objectSchema({}),
      async poll(ctx) {
        pollState.cursorsSeen.push(ctx.cursor);
        if (pollState.fail === 'auth') throw new _AuthError('token revoked');
        if (pollState.fail === 'net') throw new _RetryableError('provider 503');
        return { items: pollState.items, cursor: { seen: pollState.items.length } };
      },
    },
  ],
  actions: [
    {
      key: 'echo',
      name: 'Echo',
      description: 'Returns its input',
      input: { type: 'object', properties: {}, additionalProperties: true },
      run: async ({ input, idempotencyKey, isTest }) => {
        bump('echo');
        return { ...input, idempotencyKey, isTest };
      },
    },
    {
      key: 'typed',
      name: 'Typed',
      description: 'Needs a number',
      input: objectSchema({ n: { type: 'number' }, label: { type: 'string', default: 'none' } }, ['n']),
      run: async ({ input }) => ({ doubled: (input.n as number) * 2, label: input.label }),
    },
    {
      key: 'flaky',
      name: 'Flaky',
      description: 'Fails `times` times, then succeeds',
      input: objectSchema({ times: { type: 'integer' }, key: { type: 'string' } }, ['times', 'key']),
      run: async ({ input }) => {
        const n = bump(`flaky:${input.key}`);
        if (n <= (input.times as number)) throw new _RetryableError(`flaky failure #${n}`, n === 1 ? 5_000 : undefined);
        return { succeededOnCall: n };
      },
    },
    { key: 'boom', name: 'Boom', description: 'Fatal', input: objectSchema({}), run: async () => { bump('boom'); throw new _FatalError('bad request: 400', 'HTTP_400'); } },
    { key: 'crash', name: 'Crash', description: 'Bug', input: objectSchema({}), run: async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); } },
    { key: 'authFail', name: 'AuthFail', description: 'Auth', input: objectSchema({}), run: async () => { throw new _AuthError('token revoked'); } },
    {
      key: 'slow',
      name: 'Slow',
      description: 'Honours abort',
      timeoutMs: 1_000,
      input: objectSchema({}),
      run: ({ signal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ done: true }), 10_000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason);
          });
        }),
    },
    { key: 'hang', name: 'Hang', description: 'Ignores abort', timeoutMs: 1_000, input: objectSchema({}), run: () => new Promise(() => undefined) },
    {
      key: 'wait',
      name: 'Wait',
      description: 'Suspends',
      input: objectSchema({ ms: { type: 'integer' } }, ['ms']),
      run: async ({ input }) => {
        bump('wait');
        throw new _SuspendRun(new Date(Date.now() + (input.ms as number)));
      },
    },
    { key: 'big', name: 'Big', description: 'Too big', input: objectSchema({}), run: async () => ({ blob: 'x'.repeat(1_100_000) }) },
    { key: 'logs', name: 'Logs', description: 'Logs', input: objectSchema({}), run: async ({ logger }) => { logger.info('hello', { a: 1 }); logger.warn('careful'); return { ok: true }; } },
    { key: 'nothing', name: 'Nothing', description: 'Returns undefined', input: objectSchema({}), run: async () => undefined },
  ],
});

export function executorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([...BUILT_IN_APPS, testApp, oauthApp, testkit], OAUTH_ENV);
}
