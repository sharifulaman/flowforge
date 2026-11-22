export interface ConnectorLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON unless it's a string/Buffer/URLSearchParams. */
  body?: unknown;
  timeoutMs?: number;
  /** How to decode the body. "auto" parses JSON when the content-type says so. */
  responseType?: 'auto' | 'json' | 'text';
  /** Don't throw on non-2xx; return the response instead. */
  throwOnError?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

/**
 * SSRF-protected HTTP client provided by the runtime. Non-2xx responses throw
 * RetryableError (429/5xx) or FatalError (4xx) unless `throwOnError: false`.
 */
export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
}

export interface SandboxResult {
  result: unknown;
  logs: Array<{ level: 'log' | 'info' | 'warn' | 'error'; message: string }>;
}

/** Isolated JS runtime (isolated-vm) — only available to the Code action. */
export interface Sandbox {
  run(code: string, input: Record<string, unknown>, opts?: { timeoutMs?: number; memoryMb?: number }): Promise<SandboxResult>;
}

interface BaseContext<A> {
  /** Decrypted credentials of the step's connection (`{}` for auth type "none"). */
  auth: A;
  http: HttpClient;
  logger: ConnectorLogger;
  /** Aborted when the step times out or the run is canceled. */
  signal: AbortSignal;
  workspaceId: string;
}

export interface ActionContext<I = Record<string, any>, A = Record<string, any>> extends BaseContext<A> {
  /** Fully-resolved, schema-validated input. */
  input: I;
  /** Stable across retries of the same step in the same run (`<runId>:<stepKey>`). */
  idempotencyKey: string;
  runId: string;
  stepKey: string;
  /** True when invoked from the builder's "Test step" button. */
  isTest: boolean;
  sandbox: Sandbox;
}

export interface PollContext<I = Record<string, any>, A = Record<string, any>> extends BaseContext<A> {
  input: I;
  /** Opaque cursor returned by the previous poll (undefined on the first poll). */
  cursor: unknown;
  zapId: string;
}

export interface SubscribeContext<I = Record<string, any>, A = Record<string, any>> extends BaseContext<A> {
  input: I;
  /** Public URL the provider should deliver events to. */
  webhookUrl: string;
  zapId: string;
}

export interface OptionsContext<A = Record<string, any>> extends BaseContext<A> {
  /** Current (partial, unresolved) step config. */
  config: Record<string, unknown>;
}

export interface AuthTestContext<A = Record<string, any>> extends Omit<BaseContext<A>, 'workspaceId'> {}

export interface InboundRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Parsed body (JSON / form) or raw string. */
  body: unknown;
  /** Exact raw body for signature verification. */
  rawBody: string;
}
