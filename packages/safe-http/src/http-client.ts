import {
  FatalError,
  RetryableError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '@flowforge/connector-sdk';
import { Agent, request as undiciRequest } from 'undici';
import { assertSafeUrl, createSafeLookup, resolvePublicHost, SsrfBlockedError, type SsrfOptions } from './ssrf';

export interface SafeHttpOptions extends SsrfOptions {
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** Max response body size in bytes. */
  maxResponseBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  maxResponseBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  userAgent: 'FlowForge/1.0 (+https://flowforge.dev)',
};

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** Parse Retry-After (seconds or HTTP date) into ms, capped at 1 hour. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3_600_000) : undefined;
}

function encodeBody(body: unknown, headers: Record<string, string>): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) {
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
    return body.toString();
  }
  headers['content-type'] ??= 'application/json';
  return JSON.stringify(body);
}

function lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (v !== undefined) out[k.toLowerCase()] = String(v);
  return out;
}

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** Find the deepest error code in an error/cause chain. */
function errorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function findSsrf(err: unknown): SsrfBlockedError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof SsrfBlockedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * HTTP client used by connectors and the HTTP action:
 *  - SSRF protection (scheme allow-list, private-IP blocking at DNS + connect time, redirect re-checks)
 *  - timeouts, response-size cap, bounded redirects
 *  - maps failures to RetryableError / FatalError for the engine
 */
export class SafeHttpClient implements HttpClient {
  private readonly opts: typeof DEFAULTS & SsrfOptions;
  private readonly agent: Agent;

  constructor(
    options: SafeHttpOptions = {},
    private readonly baseSignal?: AbortSignal,
  ) {
    this.opts = { ...DEFAULTS, ...options };
    this.agent = new Agent({
      connect: { lookup: createSafeLookup(options) as never, timeout: 10_000 },
      keepAliveTimeout: 4_000,
    });
  }

  /** A client bound to a step's abort signal (timeouts / cancellation). */
  withSignal(signal: AbortSignal): SafeHttpClient {
    const c = Object.create(SafeHttpClient.prototype) as SafeHttpClient;
    Object.assign(c, this, { baseSignal: signal });
    return c;
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  async resolvePublicHost(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
    try {
      return await resolvePublicHost(hostname, this.opts);
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw new FatalError(err.message, 'SSRF_BLOCKED');
      if ((err as { code?: string }).code === 'ENOTFOUND') throw new FatalError(`Could not resolve host ${hostname}`, 'DNS_NOT_FOUND');
      throw new RetryableError(`DNS lookup for ${hostname} failed: ${(err as Error).message}`);
    }
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const timeoutMs = req.timeoutMs ?? this.opts.timeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (this.baseSignal) signals.push(this.baseSignal);
    const signal = AbortSignal.any(signals);

    let url = assertSafeUrl(req.url, this.opts);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.append(k, String(v));
    }
    let method: string = (req.method ?? 'GET').toUpperCase();
    const headers = lowerHeaders(req.headers);
    headers['user-agent'] ??= this.opts.userAgent;
    let body = encodeBody(req.body, headers);

    for (let hop = 0; ; hop++) {
      let res: Awaited<ReturnType<typeof undiciRequest>>;
      try {
        res = await undiciRequest(url, {
          method: method as never,
          headers,
          body,
          dispatcher: this.agent,
          signal,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
      } catch (err) {
        throw this.mapNetworkError(err, url, signal, timeoutMs);
      }

      if (REDIRECT_CODES.has(res.statusCode) && res.headers.location) {
        await res.body.dump().catch(() => undefined);
        if (hop >= this.opts.maxRedirects) throw new FatalError(`Too many redirects (> ${this.opts.maxRedirects})`, 'TOO_MANY_REDIRECTS');
        const next = assertSafeUrl(new URL(String(res.headers.location), url), this.opts);
        if (next.origin !== url.origin) {
          // Never forward credentials to another origin.
          delete headers.authorization;
          delete headers.cookie;
        }
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          delete headers['content-type'];
        }
        url = next;
        continue;
      }

      const text = await this.readBody(res.body, signal, url, timeoutMs);
      const resHeaders = flattenHeaders(res.headers as Record<string, string | string[] | undefined>);
      const data = this.decode(text, resHeaders['content-type'], req.responseType ?? 'auto');
      const response: HttpResponse<T> = { status: res.statusCode, headers: resHeaders, data: data as T };

      if (res.statusCode >= 400 && req.throwOnError !== false) throw this.mapStatusError(response, url);
      return response;
    }
  }

  private async readBody(stream: AsyncIterable<Buffer> & { destroy(): void }, signal: AbortSignal, url: URL, timeoutMs: number): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > this.opts.maxResponseBytes) {
          stream.destroy();
          throw new FatalError(
            `Response from ${url.host} exceeds ${Math.round(this.opts.maxResponseBytes / 1024 / 1024)} MB limit`,
            'RESPONSE_TOO_LARGE',
          );
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof FatalError) throw err;
      throw this.mapNetworkError(err, url, signal, timeoutMs);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private decode(text: string, contentType: string | undefined, mode: 'auto' | 'json' | 'text'): unknown {
    if (mode === 'text') return text;
    const looksJson = /\bjson\b/i.test(contentType ?? '');
    if (mode === 'json' || looksJson) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        if (mode === 'json') throw new FatalError('Response is not valid JSON', 'INVALID_JSON');
        return text;
      }
    }
    return text;
  }

  private mapStatusError(res: HttpResponse, url: URL): Error {
    const snippet = typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data ?? '').slice(0, 300);
    const msg = `${url.host} responded with HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`;
    const details = { status: res.status, body: res.data, headers: res.headers };
    if (res.status === 429 || res.status >= 500 || res.status === 408) {
      return new RetryableError(msg, parseRetryAfter(res.headers['retry-after']), details);
    }
    return new FatalError(msg, `HTTP_${res.status}`, details);
  }

  private mapNetworkError(err: unknown, url: URL, signal: AbortSignal, timeoutMs: number): Error {
    const ssrf = findSsrf(err);
    if (ssrf) return new FatalError(ssrf.message, 'SSRF_BLOCKED');
    if (err instanceof FatalError || err instanceof RetryableError) return err;
    if (signal.aborted) {
      const reason = signal.reason as Error | undefined;
      if (reason?.name === 'TimeoutError') return new RetryableError(`Request to ${url.host} timed out after ${timeoutMs} ms`);
      return new FatalError(`Request to ${url.host} was aborted`, 'ABORTED');
    }
    const code = errorCode(err);
    if (code === 'ENOTFOUND') return new FatalError(`Could not resolve host ${url.hostname}`, 'DNS_NOT_FOUND');
    if (code && RETRYABLE_NETWORK_CODES.has(code)) {
      return new RetryableError(`Network error contacting ${url.host} (${code})`);
    }
    return new FatalError(`Request to ${url.host} failed: ${(err as Error)?.message ?? String(err)}`, code ?? 'HTTP_ERROR');
  }
}
