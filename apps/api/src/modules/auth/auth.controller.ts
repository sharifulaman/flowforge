import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AUTH_COOKIES,
  type LoginInput,
  loginSchema,
  type MeResponse,
  type RegisterInput,
  registerSchema,
} from '@flowforge/shared';
import { randomToken } from '@flowforge/shared/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { ApiException } from '../../common/api-exception';
import { CurrentPrincipal, Public } from '../../common/decorators';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { API_ENV, type ApiEnv } from '../../config/env';
import type { Principal } from '../../types/principal';
import { AuthService } from './auth.service';
import { clearAuthCookies, OAUTH_COOKIE_PATH, setAuthCookies } from './cookies';
import { GoogleOAuthClient } from './google-oauth.client';
import { type SessionMeta, TokensService } from './tokens.service';

/** Strict limit for credential endpoints: 10 attempts per minute per client IP. */
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

function sessionMeta(req: FastifyRequest): SessionMeta {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

/** Only same-site relative paths are allowed as post-login redirects (no open redirects). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value.slice(0, 512);
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly google: GoogleOAuthClient,
  ) {}

  private get cookieOpts() {
    return { secure: this.env.COOKIE_SECURE };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: RegisterInput,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    const tokens = await this.auth.register(body, sessionMeta(req));
    setAuthCookies(reply, tokens, this.cookieOpts);
    reply.status(201);
    return this.auth.me(tokens.userId);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    const tokens = await this.auth.login(body, sessionMeta(req));
    setAuthCookies(reply, tokens, this.cookieOpts);
    return this.auth.me(tokens.userId);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const raw = req.cookies[AUTH_COOKIES.refresh];
    if (!raw) throw ApiException.unauthenticated('No refresh token');
    try {
      const tokens = await this.tokens.rotate(raw, sessionMeta(req));
      setAuthCookies(reply, tokens, this.cookieOpts);
      return { ok: true };
    } catch (err) {
      clearAuthCookies(reply, this.cookieOpts);
      throw err;
    }
  }

  /** Public so that logout works even with an expired access token. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    if (req.auth?.type === 'user') await this.tokens.revokeSession(req.auth.sessionId);
    const raw = req.cookies[AUTH_COOKIES.refresh];
    if (raw) await this.tokens.revokeByRefreshToken(raw);
    clearAuthCookies(reply, this.cookieOpts);
  }

  @Get('me')
  me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    if (principal.type !== 'user') throw ApiException.forbidden('Only user sessions can call this endpoint');
    return this.auth.me(principal.userId);
  }

  // ─── Google OAuth (Authorization Code + PKCE) ─────────────────

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Get('google')
  async googleStart(@Query('returnTo') returnTo: unknown, @Res() reply: FastifyReply): Promise<void> {
    if (!this.google.isConfigured()) {
      return void reply.redirect(`${this.env.WEB_URL}/login?error=google_not_configured`, 302);
    }
    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const signed = await this.tokens.signState({ state, codeVerifier, returnTo: safeReturnTo(returnTo) });

    reply.setCookie(AUTH_COOKIES.oauthState, signed, {
      httpOnly: true,
      sameSite: 'lax', // must survive the top-level redirect back from Google
      secure: this.env.COOKIE_SECURE,
      path: OAUTH_COOKIE_PATH,
      maxAge: 600,
    });
    return void reply.redirect(this.google.buildAuthUrl({ state, codeChallenge }), 302);
  }

  @Public()
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') oauthError: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const fail = (reason: string) => {
      req.log.warn({ reason }, 'Google sign-in failed');
      return void reply.redirect(`${this.env.WEB_URL}/login?error=${encodeURIComponent(reason)}`, 302);
    };

    const stateCookie = req.cookies[AUTH_COOKIES.oauthState];
    reply.clearCookie(AUTH_COOKIES.oauthState, { path: OAUTH_COOKIE_PATH });

    if (typeof oauthError === 'string') return fail('google_denied');
    if (typeof code !== 'string' || typeof state !== 'string' || !stateCookie) return fail('google_state');

    const saved = await this.tokens.verifyState(stateCookie);
    if (!saved || saved.state !== state || typeof saved.codeVerifier !== 'string') {
      return fail('google_state');
    }

    try {
      const profile = await this.google.exchangeCode({ code, codeVerifier: saved.codeVerifier });
      const tokens = await this.auth.loginWithGoogle(profile, sessionMeta(req));
      setAuthCookies(reply, tokens, this.cookieOpts);
      return void reply.redirect(`${this.env.WEB_URL}${safeReturnTo(saved.returnTo)}`, 302);
    } catch (err) {
      if (err instanceof ApiException && err.getStatus() === 403) return fail('google_unverified');
      req.log.error({ err }, 'Google OAuth exchange error');
      return fail('google_failed');
    }
  }
}
