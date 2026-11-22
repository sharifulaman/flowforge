import { defineApp, objectSchema } from '@flowforge/connector-sdk';

/** Catch Hook: every request to the zap's unique URL starts a run. */
export default defineApp({
  key: 'webhook',
  name: 'Webhooks',
  description: 'Start a Zap when any service sends an HTTP request to a unique URL.',
  category: 'core',
  icon: 'Webhook',
  color: '#f97316',
  auth: { type: 'none' },
  triggers: [
    {
      key: 'catchHook',
      name: 'Catch Hook',
      kind: 'webhook',
      description: 'Triggers on every request (GET/POST/PUT/PATCH/DELETE) to the Zap’s webhook URL.',
      input: objectSchema({}),
      sampleOutput: {
        method: 'POST',
        body: { email: 'jane@example.com', name: 'Jane Doe', plan: 'pro' },
        query: {},
        headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' },
        receivedAt: '2026-01-01T12:00:00.000Z',
      },
    },
  ],
});
