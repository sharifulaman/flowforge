import { describe, expect, it } from 'vitest';
import {
  ConnectorRegistry,
  defineApp,
  objectSchema,
  secretFields,
  validateConfig,
  validateInput,
  type AppDefinition,
  type ObjectSchema,
} from '../src';

const base: AppDefinition = {
  key: 'acme',
  name: 'Acme',
  description: 'Acme CRM',
  category: 'productivity',
  icon: 'Building2',
  color: '#0ea5e9',
  auth: {
    type: 'api_key',
    fields: objectSchema({ apiKey: { type: 'string', 'x-ui': { widget: 'password' } }, region: { type: 'string' } }, ['apiKey']),
  },
  optionLoaders: { lists: async () => [{ label: 'Main', value: 'main' }] },
  actions: [
    {
      key: 'createLead',
      name: 'Create lead',
      description: 'Adds a lead',
      input: objectSchema(
        {
          email: { type: 'string', format: 'email' },
          score: { type: 'integer', minimum: 0, default: 10 },
          list: { type: 'string', 'x-ui': { dynamicOptions: 'lists' } },
          tags: { type: 'array', items: { type: 'string' } },
          address: objectSchema({ city: { type: 'string' }, zip: { type: 'string', pattern: '^\\d{5}$' } }, ['city']),
        },
        ['email'],
      ),
      run: async ({ input }) => input,
    },
  ],
};

describe('defineApp', () => {
  it('accepts a valid definition', () => {
    const app = defineApp(base);
    expect(app.actions).toHaveLength(1);
    expect(app.triggers).toEqual([]);
    expect(Object.isFrozen(app)).toBe(true);
  });

  it.each([
    [{ ...base, key: 'Bad Key' }, /App key/],
    [{ ...base, actions: [], triggers: [] }, /no triggers or actions/],
    [{ ...base, actions: [base.actions![0]!, base.actions![0]!] }, /Duplicate action key/],
    [{ ...base, optionLoaders: {} }, /dynamicOptions "lists"/],
    [
      { ...base, actions: [{ ...base.actions![0]!, input: { type: 'object', properties: { a: { type: 'nope' } } } }] },
      /Invalid input schema/,
    ],
    [
      {
        ...base,
        triggers: [
          { key: 'poll', name: 'p', description: 'd', kind: 'polling', intervalSeconds: 5, input: objectSchema({}), poll: async () => ({ items: [] }) },
        ],
      },
      /intervalSeconds/,
    ],
  ])('rejects invalid definitions (%#)', (def, msg) => {
    expect(() => defineApp(def as AppDefinition)).toThrow(msg);
  });
});

describe('validateConfig (publish-time)', () => {
  const schema = base.actions![0]!.input;

  it('accepts templated values for any type, but enforces required', () => {
    expect(validateConfig(schema, { email: '{{ trigger.email }}', score: '{{ step1.n }}' })).toEqual([]);
    expect(validateConfig(schema, { score: 5 })).toEqual([{ field: 'email', message: 'This field is required' }]);
    expect(validateConfig(schema, { email: '   ' })).toEqual([{ field: 'email', message: 'This field is required' }]);
  });

  it('type-checks literal values', () => {
    const issues = validateConfig(schema, { email: 'not-an-email', score: -1, bogus: 1 });
    expect(issues.map((i) => i.field).sort()).toEqual(['bogus', 'email', 'score']);
  });

  it('recurses into nested objects', () => {
    expect(validateConfig(schema, { email: 'a@b.co', address: { zip: '12' } }).map((i) => i.field).sort()).toEqual([
      'address.city',
      'address.zip',
    ]);
    expect(validateConfig(schema, { email: 'a@b.co', address: { city: '{{ trigger.city }}', zip: '{{ trigger.zip }}' } })).toEqual([]);
  });

  it('still rejects unknown fields that contain templates', () => {
    expect(validateConfig(schema, { email: 'a@b.co', bogus: '{{ trigger.x }}' })).toEqual([{ field: 'bogus', message: 'Unknown field' }]);
  });

  it('accepts arrays containing templates', () => {
    expect(validateConfig(schema, { email: 'a@b.co', tags: ['x', '{{ trigger.tag }}'] })).toEqual([]);
  });
});

describe('validateInput (runtime)', () => {
  it('applies defaults without mutating the input', () => {
    const input = { email: 'a@b.co' };
    const r = validateInput(base.actions![0]!.input, input);
    expect(r).toEqual({ ok: true, value: { email: 'a@b.co', score: 10 } });
    expect(input).toEqual({ email: 'a@b.co' });
  });

  it('returns issues for resolved values of the wrong type', () => {
    const r = validateInput(base.actions![0]!.input, { email: 'a@b.co', score: 'ten' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ field: 'score' });
  });
});

describe('ConnectorRegistry', () => {
  it('looks up operations and produces function-free manifests', () => {
    const oauthApp = defineApp({
      ...base,
      key: 'oauthy',
      auth: { type: 'oauth2', authorizeUrl: 'https://x/a', tokenUrl: 'https://x/t', scopes: ['s'], clientIdEnv: 'OAUTHY_ID', clientSecretEnv: 'OAUTHY_SECRET' },
    });
    const reg = new ConnectorRegistry([defineApp(base), oauthApp], { OAUTHY_ID: 'id' });
    expect(reg.getAction('acme', 'createLead')?.name).toBe('Create lead');
    expect(reg.getAction('acme', 'nope')).toBeUndefined();
    expect(reg.getTrigger('ghost', 'x')).toBeUndefined();

    const manifests = reg.manifests();
    expect(JSON.parse(JSON.stringify(manifests))).toEqual(manifests); // serializable
    expect(manifests.find((m) => m.key === 'oauthy')!.auth).toMatchObject({ type: 'oauth2', available: false, scopes: ['s'] });
    expect(manifests.find((m) => m.key === 'acme')!.auth.available).toBe(true);
    expect(() => reg.register(defineApp(base))).toThrow(/Duplicate/);
  });

  it('identifies secret auth fields', () => {
    expect(secretFields((base.auth as { fields: ObjectSchema }).fields)).toEqual(['apiKey']);
  });
});
