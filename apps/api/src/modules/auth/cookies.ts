import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_COOKIES,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from '@flowforge/shared';
import type { FastifyReply } from 'fastify';

export const OAUTH_COOKIE_PATH = '/api/v1/auth/google';

interface CookieOpts {
  secure: boolean;
}

/**
 * Sets the auth cookies:
 *  - ff_at  access JWT, httpOnly, sent everywhere on our origin.
 *  - ff_rt  refresh token, httpOnly, only sent to /api/v1/auth.
 *  - ff_s   non-secret "has a session" marker so the Next.js middleware can gate pages
 *           even after the access token expired (ff_rt is not visible to it due to path).
 */
export function setAuthCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string },
  { secure }: CookieOpts,
): void {
  const base = { httpOnly: true, sameSite: 'lax' as const, secure };
  reply.setCookie(AUTH_COOKIES.access, tokens.accessToken, {
    ...base,
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });
  reply.setCookie(AUTH_COOKIES.refresh, tokens.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
  reply.setCookie(AUTH_COOKIES.session, '1', {
    ...base,
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
}

export function clearAuthCookies(reply: FastifyReply, { secure }: CookieOpts): void {
  const base = { httpOnly: true, sameSite: 'lax' as const, secure };
  reply.clearCookie(AUTH_COOKIES.access, { ...base, path: '/' });
  reply.clearCookie(AUTH_COOKIES.refresh, { ...base, path: REFRESH_COOKIE_PATH });
  reply.clearCookie(AUTH_COOKIES.session, { ...base, path: '/' });
}
