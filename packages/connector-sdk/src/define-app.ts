import type { ActionDefinition, AppDefinition, TriggerDefinition } from './definitions';
import type { JSONSchema } from './schema';
import { assertValidSchema } from './validation';

const KEY_RE = /^[a-z][a-z0-9-]{1,62}$/;
const OP_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface DefinedApp extends AppDefinition {
  readonly triggers: TriggerDefinition<any>[];
  readonly actions: ActionDefinition<any, any>[];
}

function collectDynamicOptions(schema: JSONSchema, out: string[] = []): string[] {
  const name = schema['x-ui']?.dynamicOptions;
  if (name) out.push(name);
  for (const child of Object.values(schema.properties ?? {})) collectDynamicOptions(child, out);
  if (schema.items) collectDynamicOptions(schema.items, out);
  return out;
}

/**
 * Declare a connector. Validates the definition eagerly so mistakes fail at startup
 * (and in the connector's unit tests), not at run time.
 *
 * @example
 * export default defineApp({
 *   key: 'acme', name: 'Acme', description: 'Acme CRM', category: 'productivity',
 *   icon: 'Building2', color: '#0ea5e9',
 *   auth: { type: 'api_key', fields: objectSchema({ apiKey: { type: 'string' } }, ['apiKey']) },
 *   actions: [{
 *     key: 'createLead', name: 'Create lead', description: 'Adds a lead',
 *     input: objectSchema({ email: { type: 'string', format: 'email' } }, ['email']),
 *     run: async ({ input, auth, http }) =>
 *       (await http.request({ url: 'https://api.acme.test/leads', method: 'POST',
 *         headers: { authorization: `Bearer ${auth.apiKey}` }, body: input })).data,
 *   }],
 * });
 */
export function defineApp(def: AppDefinition): DefinedApp {
  if (!KEY_RE.test(def.key)) throw new Error(`App key "${def.key}" must match ${KEY_RE}`);
  const triggers = def.triggers ?? [];
  const actions = def.actions ?? [];
  if (!triggers.length && !actions.length) throw new Error(`App "${def.key}" defines no triggers or actions`);

  const where = (kind: string, key: string) => `${def.key}.${kind}.${key}`;
  const seen = new Set<string>();
  for (const op of [...triggers.map((t) => ['trigger', t] as const), ...actions.map((a) => ['action', a] as const)]) {
    const [kind, o] = op;
    if (!OP_KEY_RE.test(o.key)) throw new Error(`Invalid ${kind} key "${o.key}" in app "${def.key}"`);
    const id = `${kind}:${o.key}`;
    if (seen.has(id)) throw new Error(`Duplicate ${kind} key "${o.key}" in app "${def.key}"`);
    seen.add(id);
    if (o.input?.type !== 'object') throw new Error(`${where(kind, o.key)}: input must be an object schema`);
    assertValidSchema(o.input, where(kind, o.key));
    for (const loader of collectDynamicOptions(o.input)) {
      if (!def.optionLoaders?.[loader]) {
        throw new Error(`${where(kind, o.key)}: dynamicOptions "${loader}" has no matching optionLoaders entry`);
      }
    }
  }
  for (const t of triggers) {
    if (t.kind === 'polling' && t.intervalSeconds < 60) {
      throw new Error(`${where('trigger', t.key)}: intervalSeconds must be >= 60`);
    }
  }
  if (def.auth.type === 'api_key' || def.auth.type === 'basic' || def.auth.type === 'custom') {
    assertValidSchema(def.auth.fields, `${def.key}.auth`);
  }
  return Object.freeze({ ...def, triggers, actions });
}
