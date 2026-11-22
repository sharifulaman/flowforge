import type { ActionContext, HttpClient, HttpRequest, HttpResponse, Sandbox } from '@flowforge/connector-sdk';

export interface Route {
  match: (req: HttpRequest) => boolean;
  respond: (req: HttpRequest) => Partial<HttpResponse> & { status?: number };
}

/** Records requests and answers from a route table — no network in connector tests. */
export class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private routes: Route[] = []) {}

  on(match: (r: HttpRequest) => boolean, respond: Route['respond']): this {
    this.routes.push({ match, respond });
    return this;
  }

  async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(req);
    const route = this.routes.find((r) => r.match(req));
    if (!route) throw new Error(`No fake route for ${req.method ?? 'GET'} ${req.url}`);
    const r = route.respond(req);
    const res = { status: r.status ?? 200, headers: r.headers ?? {}, data: r.data as T };
    if (res.status >= 400 && req.throwOnError !== false) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res;
  }

  async resolvePublicHost(hostname: string) {
    return { address: hostname, family: 4 as const };
  }
}

export const urlIncludes = (s: string) => (r: HttpRequest) => r.url.includes(s);

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function actionCtx<I extends Record<string, unknown>>(p: {
  input: I;
  auth?: Record<string, any>;
  http?: HttpClient;
  sandbox?: Sandbox;
  isTest?: boolean;
  logs?: Array<{ level: string; message: string }>;
}): ActionContext<I> {
  const logs = p.logs ?? [];
  const log = (level: string) => (message: string) => void logs.push({ level, message });
  return {
    input: p.input,
    auth: p.auth ?? {},
    http: p.http ?? new FakeHttp(),
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    signal: new AbortController().signal,
    workspaceId: 'ws_1',
    idempotencyKey: 'run_1:step1',
    runId: 'run_1',
    stepKey: 'step1',
    isTest: p.isTest ?? false,
    sandbox: p.sandbox ?? { run: async () => ({ result: null, logs: [] }) },
  };
}
