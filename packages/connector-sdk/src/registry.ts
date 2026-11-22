import type { DefinedApp } from './define-app';
import type { ActionDefinition, AuthType, TriggerDefinition, TriggerKind } from './definitions';
import type { JSONSchema, ObjectSchema } from './schema';

/** Serializable description of an app (no functions) for the API and UI. */
export interface AppManifest {
  key: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  auth: {
    type: AuthType;
    fields?: ObjectSchema;
    scopes?: string[];
    instructions?: string;
    /** OAuth apps: false when the server lacks client credentials. */
    available: boolean;
  };
  triggers: Array<{
    key: string;
    name: string;
    description: string;
    kind: TriggerKind;
    input: ObjectSchema;
    sampleOutput?: Record<string, unknown>;
  }>;
  actions: Array<{
    key: string;
    name: string;
    description: string;
    input: ObjectSchema;
    sampleOutput?: Record<string, unknown>;
    timeoutMs?: number;
  }>;
}

export class ConnectorRegistry {
  private readonly apps = new Map<string, DefinedApp>();

  constructor(
    apps: DefinedApp[] = [],
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    for (const app of apps) this.register(app);
  }

  register(app: DefinedApp): void {
    if (this.apps.has(app.key)) throw new Error(`Duplicate app key "${app.key}"`);
    this.apps.set(app.key, app);
  }

  get(appKey: string): DefinedApp | undefined {
    return this.apps.get(appKey);
  }

  getTrigger(appKey: string, key: string): TriggerDefinition | undefined {
    return this.apps.get(appKey)?.triggers.find((t) => t.key === key);
  }

  getAction(appKey: string, key: string): ActionDefinition | undefined {
    return this.apps.get(appKey)?.actions.find((a) => a.key === key);
  }

  all(): DefinedApp[] {
    return [...this.apps.values()];
  }

  /** OAuth apps need client credentials configured on the server. */
  isAvailable(app: DefinedApp): boolean {
    if (app.auth.type !== 'oauth2') return true;
    return Boolean(this.env[app.auth.clientIdEnv] && this.env[app.auth.clientSecretEnv]);
  }

  manifest(app: DefinedApp): AppManifest {
    const auth = app.auth;
    return {
      key: app.key,
      name: app.name,
      description: app.description,
      category: app.category,
      icon: app.icon,
      color: app.color,
      auth: {
        type: auth.type,
        fields: 'fields' in auth ? auth.fields : undefined,
        scopes: auth.type === 'oauth2' ? auth.scopes : undefined,
        instructions: 'instructions' in auth ? auth.instructions : undefined,
        available: this.isAvailable(app),
      },
      triggers: app.triggers.map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        kind: t.kind,
        input: t.input,
        sampleOutput: t.sampleOutput,
      })),
      actions: app.actions.map((a) => ({
        key: a.key,
        name: a.name,
        description: a.description,
        input: a.input,
        sampleOutput: a.sampleOutput,
        timeoutMs: a.timeoutMs,
      })),
    };
  }

  manifests(): AppManifest[] {
    return this.all()
      .map((a) => this.manifest(a))
      .sort((a, b) => (a.category === 'core' ? -1 : 0) - (b.category === 'core' ? -1 : 0) || a.name.localeCompare(b.name));
  }
}

/** Collect field names that the auth schema marks as secret (never echoed back). */
export function secretFields(schema: JSONSchema | undefined): string[] {
  return Object.entries(schema?.properties ?? {})
    .filter(([, s]) => s['x-ui']?.widget === 'password')
    .map(([k]) => k);
}
