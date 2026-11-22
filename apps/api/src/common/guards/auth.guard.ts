import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_COOKIES } from '@flowforge/shared';
import type { FastifyRequest } from 'fastify';
import { ApiKeyAuthService } from '../../modules/api-keys/api-key-auth.service';
import { TokensService } from '../../modules/auth/tokens.service';
import type { Principal } from '../../types/principal';
import { ApiException } from '../api-exception';
import { ALLOW_API_KEY, IS_PUBLIC } from '../decorators';

/**
 * Global guard. Resolves the principal from (in order):
 *   1. `Authorization: Bearer ff_live_…`  → workspace-bound API key
 *   2. `ff_at` httpOnly cookie            → user session (JWT + live session check)
 *
 * Public routes still get `req.auth` populated when credentials are present.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly apiKeys: ApiKeyAuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) ?? false;
    const allowApiKey = this.reflector.getAllAndOverride<boolean>(ALLOW_API_KEY, targets) ?? false;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();

    const bearer = this.bearer(req);
    if (bearer) {
      const principal = await this.apiKeys.authenticate(bearer);
      if (principal) {
        req.auth = principal;
        req.log = req.log.child({ apiKeyId: principal.apiKeyId });
        if (isPublic) return true;
        if (!allowApiKey) throw ApiException.forbidden('API keys cannot access this endpoint');
        return true;
      }
      if (!isPublic) throw ApiException.unauthenticated('Invalid API key');
    }

    const principal = await this.fromCookie(req);
    if (principal) {
      req.auth = principal;
      req.log = req.log.child({ userId: principal.userId });
    }
    if (isPublic || principal) return true;
    throw ApiException.unauthenticated();
  }

  private bearer(req: FastifyRequest): string | null {
    const h = req.headers.authorization;
    if (!h) return null;
    const [scheme, value] = h.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
  }

  private async fromCookie(req: FastifyRequest): Promise<Extract<Principal, { type: 'user' }> | null> {
    const token = req.cookies?.[AUTH_COOKIES.access];
    if (!token) return null;
    const claims = await this.tokens.verifyAccess(token);
    if (!claims) return null;
    // Live check so logout / refresh-token-reuse revocation is effective immediately.
    if (!(await this.tokens.isSessionActive(claims.sessionId, claims.userId))) return null;
    return { type: 'user', userId: claims.userId, sessionId: claims.sessionId };
  }
}
