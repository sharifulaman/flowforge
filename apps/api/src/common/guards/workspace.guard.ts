import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@flowforge/db';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiException } from '../api-exception';
import { REQUIRED_ROLES } from '../decorators';

const ROLE_RANK: Record<Role, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

/** True when `actual` is at least as privileged as the least-privileged role in `required`. */
export function hasRole(actual: Role, required: Role[]): boolean {
  if (required.length === 0) return true;
  const min = Math.min(...required.map((r) => ROLE_RANK[r]));
  return ROLE_RANK[actual] >= min;
}

/**
 * Resolves `:workspaceId` from the route and verifies the principal belongs to it.
 * Non-members get 404 (not 403) so workspace ids can't be probed.
 * API keys act with their creator's current role — removing the member disables their keys.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest<{ Params: { workspaceId?: string } }>>();
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) throw new Error('WorkspaceGuard requires a :workspaceId route param');
    const principal = req.auth;
    if (!principal) throw ApiException.unauthenticated();

    let userId: string;
    if (principal.type === 'apiKey') {
      if (principal.workspaceId !== workspaceId) throw ApiException.notFound('Workspace');
      userId = principal.actingUserId;
    } else {
      userId = principal.userId;
    }

    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw ApiException.notFound('Workspace');

    const required =
      this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [ctx.getHandler(), ctx.getClass()]) ?? [];
    if (!hasRole(membership.role, required)) {
      throw ApiException.forbidden('Your role does not allow this action');
    }

    req.workspace = { id: workspaceId, role: membership.role };
    req.log = req.log.child({ workspaceId });
    return true;
  }
}
