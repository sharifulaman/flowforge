import { defineApp, objectSchema } from '@flowforge/connector-sdk';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

/** Generic HTTP request through the runtime's SSRF-safe client. */
export default defineApp({
  key: 'http',
  name: 'HTTP Request',
  description: 'Call any HTTP API.',
  category: 'core',
  icon: 'Globe',
  color: '#0ea5e9',
  auth: { type: 'none' },
  actions: [
    {
      key: 'request',
      name: 'Make a request',
      description: 'Send an HTTP request and use the response in later steps.',
      timeoutMs: 30_000,
      input: objectSchema(
        {
          method: { type: 'string', title: 'Method', enum: [...METHODS], default: 'GET', 'x-ui': { widget: 'select', noTemplates: true } },
          url: { type: 'string', title: 'URL', minLength: 1, 'x-ui': { placeholder: 'https://api.example.com/items' } },
          query: { type: 'object', title: 'Query parameters', additionalProperties: { type: 'string' }, 'x-ui': { widget: 'keyvalue' } },
          headers: { type: 'object', title: 'Headers', additionalProperties: { type: 'string' }, 'x-ui': { widget: 'keyvalue' } },
          bodyType: {
            type: 'string',
            title: 'Body type',
            enum: ['none', 'json', 'form', 'raw'],
            'x-enumLabels': ['No body', 'JSON', 'Form (urlencoded)', 'Raw text'],
            default: 'none',
            'x-ui': { widget: 'select', noTemplates: true },
          },
          body: { title: 'Body', description: 'JSON object/array, form fields, or raw text depending on body type.', 'x-ui': { widget: 'json' } },
          failOnError: { type: 'boolean', title: 'Fail the step on 4xx/5xx', default: true, 'x-ui': { widget: 'toggle', advanced: true } },
        },
        ['method', 'url'],
      ),
      sampleOutput: { status: 200, headers: { 'content-type': 'application/json' }, body: { id: 123, ok: true } },
      async run({ input, http }) {
        const headers: Record<string, string> = { ...(input.headers ?? {}) };
        let body: unknown;
        switch (input.bodyType) {
          case 'json':
            body = typeof input.body === 'string' ? safeJson(input.body) : input.body;
            break;
          case 'form':
            body = new URLSearchParams(Object.entries((input.body ?? {}) as Record<string, unknown>).map(([k, v]): [string, string] => [k, String(v ?? "")]));
            break;
          case 'raw':
            body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? '');
            headers['content-type'] ??= 'text/plain; charset=utf-8';
            break;
        }
        const res = await http.request({ url: input.url, method: input.method, headers, query: input.query, body, throwOnError: input.failOnError !== false });
        return { status: res.status, headers: res.headers, body: res.data };
      },
    },
  ],
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
