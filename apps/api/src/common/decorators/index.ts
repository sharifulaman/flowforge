import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@flowforge/db';
import type { FastifyRequest } from 'fastify';
import type { Principal, WorkspaceContext } from '../../types/principal';
import { ApiException } from '../api-exception';

export const IS_PUBLIC = 'ff:isPublic';
export const ALLOW_API_KEY = 'ff:allowApiKey';
export const REQUIRED_ROLES = 'ff:requiredRoles';

/** Skip authentication for this route/controller. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Allow workspace-bound API keys (`Authorization: Bearer ff_live_…`) in addition to sessions. */
export const AllowApiKey = () => SetMetadata(ALLOW_API_KEY, true);

/** Minimum workspace role(s) required (checked by WorkspaceGuard). */
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

/** The authenticated principal (user session or API key). */
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.auth) throw ApiException.unauthenticated();
  return req.auth;
});

/** The acting user id: the session user, or the user who created the API key. */
export const CurrentUserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.auth) throw ApiException.unauthenticated();
  return req.auth.type === 'user' ? req.auth.userId : req.auth.actingUserId;
});

/** The workspace resolved by WorkspaceGuard. */
export const CurrentWorkspace = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): WorkspaceContext => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!req.workspace) throw new Error('CurrentWorkspace used on a route without WorkspaceGuard');
    return req.workspace;
  },
);
