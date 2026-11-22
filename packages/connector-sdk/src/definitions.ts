import type {
  ActionContext,
  AuthTestContext,
  InboundRequest,
  OptionsContext,
  PollContext,
  SubscribeContext,
} from './context';
import type { ObjectSchema } from './schema';

// ─── Auth ──────────────────────────────────────────────────

/** Non-secret info shown next to a connection (e.g. the account email). */
export interface ConnectionInfo {
  label?: string;
  [key: string]: unknown;
}

export interface OAuth2Credentials {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp. */
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

export type AuthDefinition =
  | { type: 'none' }
  | {
      type: 'api_key' | 'basic' | 'custom';
      /** Credential fields; mark secrets with `x-ui: { widget: 'password' }`. */
      fields: ObjectSchema;
      instructions?: string;
      /** Verify credentials; return display info. Throw AuthError on bad credentials. */
      test?: (ctx: AuthTestContext) => Promise<ConnectionInfo | void>;
    }
  | {
      type: 'oauth2';
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
      /** Env var names holding the OAuth client credentials. */
      clientIdEnv: string;
      clientSecretEnv: string;
      scopeSeparator?: string;
      pkce?: boolean;
      /** Extra params for the authorize URL (e.g. access_type=offline). */
      authorizeParams?: Record<string, string>;
      instructions?: string;
      test?: (ctx: AuthTestContext<OAuth2Credentials>) => Promise<ConnectionInfo | void>;
    };

export type AuthType = AuthDefinition['type'];

// ─── Operations ────────────────────────────────────────────

export interface ValidationIssue {
  field?: string;
  message: string;
}

interface OperationBase<I> {
  key: string;
  name: string;
  description: string;
  input: ObjectSchema;
  /** Example output, used by the field picker before the step is tested. */
  sampleOutput?: Record<string, unknown>;
  /**
   * Semantic validation beyond the JSON schema (e.g. cron syntax). Called at publish time
   * with the raw config; templated values are left as strings.
   */
  validate?: (config: Partial<I>) => ValidationIssue[];
}

export interface ActionDefinition<I = Record<string, any>, O = unknown> extends OperationBase<I> {
  /** Default per-step timeout (ms). Users can override per step. */
  timeoutMs?: number;
  run(ctx: ActionContext<I>): Promise<O>;
}

export interface PolledItem {
  /** Stable unique id used for de-duplication. */
  id: string;
  data: Record<string, unknown>;
}

export interface WebhookTriggerDefinition<I = Record<string, any>> extends OperationBase<I> {
  /** Generic catch-hook: every request to the zap's URL starts a run. */
  kind: 'webhook';
}

export interface ScheduleTriggerDefinition<I = Record<string, any>> extends OperationBase<I> {
  kind: 'schedule';
  /** Map the step config to a repeat spec. */
  schedule(config: I): { cron: string; timezone?: string } | { everyMs: number };
}

export interface PollingTriggerDefinition<I = Record<string, any>> extends OperationBase<I> {
  kind: 'polling';
  /** How often to poll (seconds). Minimum 60. */
  intervalSeconds: number;
  poll(ctx: PollContext<I>): Promise<{ items: PolledItem[]; cursor?: unknown }>;
}

export interface AppWebhookTriggerDefinition<I = Record<string, any>> extends OperationBase<I> {
  kind: 'app_webhook';
  /** Register `ctx.webhookUrl` with the provider; return data needed to unsubscribe. */
  subscribe(ctx: SubscribeContext<I>): Promise<unknown>;
  unsubscribe(ctx: SubscribeContext<I>, subscription: unknown): Promise<void>;
  /** Verify the delivery is authentic (signature, secret token). */
  verify?(req: InboundRequest, ctx: { auth: Record<string, any>; subscription: unknown; input: I }): boolean | Promise<boolean>;
  /** Turn a delivery into zero or more events (each starts a run). */
  parse(req: InboundRequest): PolledItem[] | Promise<PolledItem[]>;
}

export type TriggerDefinition<I = Record<string, any>> =
  | WebhookTriggerDefinition<I>
  | ScheduleTriggerDefinition<I>
  | PollingTriggerDefinition<I>
  | AppWebhookTriggerDefinition<I>;

export type TriggerKind = TriggerDefinition['kind'];

export interface SelectOption {
  label: string;
  value: string | number;
}

export type OptionLoader = (ctx: OptionsContext) => Promise<SelectOption[]>;

// ─── App ───────────────────────────────────────────────────

export interface AppDefinition {
  /** Unique, url-safe key ("slack", "google-sheets"). Never change it once published. */
  key: string;
  name: string;
  description: string;
  category: 'core' | 'communication' | 'productivity' | 'developer' | 'marketing' | 'data';
  /** lucide-react icon name used by the UI (e.g. "Webhook", "Mail"). */
  icon: string;
  /** Brand accent color (hex). */
  color: string;
  auth: AuthDefinition;
  triggers?: TriggerDefinition<any>[];
  actions?: ActionDefinition<any, any>[];
  optionLoaders?: Record<string, OptionLoader>;
}
