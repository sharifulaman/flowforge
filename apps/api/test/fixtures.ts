import { AuthError, ConnectorRegistry, defineApp, objectSchema } from '@flowforge/connector-sdk';
import { BUILT_IN_APPS } from '@flowforge/connectors';
import { createHmac } from 'node:crypto';

export const SIGNING_SECRET = 'whsec_test';
export const subscriptions: Array<{ webhookUrl: string; input: unknown }> = [];
export const unsubscriptions: unknown[] = [];

/** API-key app with a credential test, an option loader and an app-event trigger. */
export const acme = defineApp({
  key: 'acme',
  name: 'Acme',
  description: 'Acme CRM (test)',
  category: 'productivity',
  icon: 'Building2',
  color: '#0ea5e9',
  auth: {
    type: 'api_key',
    fields: objectSchema(
      { apiKey: { type: 'string', minLength: 4, 'x-ui': { widget: 'password' } }, account: { type: 'string' } },
      ['apiKey'],
    ),
    test: async ({ auth }) => {
      if (auth.apiKey === 'bad-key') throw new AuthError('API key rejected');
      if (auth.apiKey === 'down-key') throw new Error('acme is down');
      return { label: `Acme (${auth.account ?? 'default'})` };
    },
  },
  optionLoaders: {
    lists: async ({ auth, config }) => [
      { label: `Main list for ${auth.account ?? 'default'}`, value: 'main' },
      { label: `Filtered by ${String(config.filter ?? 'none')}`, value: 'filtered' },
    ],
  },
  triggers: [
    {
      key: 'newContact',
      name: 'New contact',
      description: 'Fires when a contact is created',
      kind: 'app_webhook',
      input: objectSchema({ list: { type: 'string', 'x-ui': { dynamicOptions: 'lists' } } }, ['list']),
      sampleOutput: { id: 'c_1', email: 'sample@acme.test' },
      async subscribe(ctx) {
        subscriptions.push({ webhookUrl: ctx.webhookUrl, input: ctx.input });
        return { hookId: `hook_${subscriptions.length}` };
      },
      async unsubscribe(_ctx, sub) {
        unsubscriptions.push(sub);
      },
      verify: (req) => {
        const sig = createHmac('sha256', SIGNING_SECRET).update(req.rawBody).digest('hex');
        return req.headers['x-acme-signature'] === sig;
      },
      parse: (req) => {
        const body = req.body as { events: Array<{ id: string; contact: Record<string, unknown> }> };
        return body.events.map((e) => ({ id: e.id, data: e.contact }));
      },
    },
  ],
  actions: [
    {
      key: 'createContact',
      name: 'Create contact',
      description: 'Creates a contact',
      input: objectSchema({ email: { type: 'string', format: 'email' }, list: { type: 'string', 'x-ui': { dynamicOptions: 'lists' } } }, ['email']),
      sampleOutput: { id: 'c_2', email: 'x@acme.test' },
      run: async ({ input }) => ({ id: 'c_new', ...input }),
    },
  ],
});

export const oauthy = defineApp({
  key: 'oauthy',
  name: 'OAuthy',
  description: 'OAuth app (test)',
  category: 'productivity',
  icon: 'Box',
  color: '#111111',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://auth.oauthy.test/authorize',
    tokenUrl: 'https://auth.oauthy.test/token',
    scopes: ['read', 'write'],
    clientIdEnv: 'OAUTHY_CLIENT_ID',
    clientSecretEnv: 'OAUTHY_CLIENT_SECRET',
    test: async ({ auth }) => ({ label: `oauthy:${auth.accessToken.slice(0, 6)}` }),
  },
  actions: [{ key: 'ping', name: 'Ping', description: 'Ping', input: objectSchema({}), run: async () => ({ pong: true }) }],
});

export function testRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([...BUILT_IN_APPS, acme, oauthy]);
}

/** Fake OAuth token endpoint. */
export const oauthCalls: Array<Record<string, string>> = [];
export async function fakeOAuthFetch(_url: string, init?: RequestInit): Promise<Response> {
  const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
  oauthCalls.push(params);
  if (params.code === 'bad-code') {
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return new Response(
    JSON.stringify({ access_token: `at_${params.code}`, refresh_token: 'rt_1', expires_in: 3600, scope: 'read write' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
