import type { InboundRequest } from '@flowforge/connector-sdk';
import type { FastifyRequest } from 'fastify';

/** Headers never stored in run history (credentials, hop-by-hop, proxy internals). */
const DROP_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
]);

export function safeHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_HEADERS.has(k)) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

export function queryRecord(req: FastifyRequest): Record<string, string> {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]));
}

export function toInbound(req: FastifyRequest): InboundRequest {
  const raw = (req as FastifyRequest & { rawBody?: Buffer | string }).rawBody;
  const rawBody = raw !== undefined ? raw.toString() : typeof req.body === 'string' ? req.body : '';
  const allHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) allHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
  return { method: req.method, headers: allHeaders, query: queryRecord(req), body: req.body ?? null, rawBody };
}

const IDEMPOTENCY_HEADERS = ['idempotency-key', 'x-idempotency-key'];

/** Sender-supplied idempotency key, if any (max 200 chars). */
export function idempotencyKeyFrom(req: FastifyRequest): string | null {
  for (const h of IDEMPOTENCY_HEADERS) {
    const v = req.headers[h];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}

export const HOOK_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
