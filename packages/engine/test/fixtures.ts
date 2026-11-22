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
