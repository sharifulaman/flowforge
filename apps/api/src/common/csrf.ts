import { AUTH_COOKIES } from '@flowforge/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests (on top of SameSite=Lax):
 * a state-changing request that carries our auth cookies must come from an allowed Origin.
 *
 * Requests without auth cookies (API keys, public webhooks, server-to-server) are not
 * vulnerable to CSRF and pass through. Paths under /hooks/ are always exempt.
 */
export function createCsrfHook(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));

  return async function csrfHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.url.startsWith('/hooks/')) return;

    const cookies = req.cookies ?? {};
    const usesCookieAuth =
      cookies[AUTH_COOKIES.access] !== undefined || cookies[AUTH_COOKIES.refresh] !== undefined;
    if (!usesCookieAuth) return;

    const origin = req.headers.origin ?? originFromReferer(req.headers.referer);
    if (origin && allowed.has(origin)) return;

    await reply.status(403).send({
      error: {
        code: 'CSRF_REJECTED',
        message: 'Cross-site request rejected',
        requestId: req.id,
      },
    });
  };
}

function originFromReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
