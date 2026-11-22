import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, Workspace } from '@flowforge/db';
import type { TriggerManager } from '@flowforge/engine';
import type { CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceRole } from '@flowforge/shared';
import { randomBytes } from 'node:crypto';
import { ApiException } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { TRIGGER_MANAGER } from '../../runtime/tokens';

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  createdAt: string;
}

const MAX_WORKSPACES_PER_USER = 20;

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRIGGER_MANAGER) private readonly triggers: TriggerManager,
  ) {}

  /** Create a workspace owned by `userId`. Runs inside the caller's transaction. */
  createPersonal(tx: Prisma.TransactionClient, userId: string, ownerName: string): Promise<Workspace> {
    const name = `${ownerName.split(' ')[0] || 'My'}'s Workspace`;
    return tx.workspace.create({
      data: { name, slug: slugify(name), memberships: { create: { userId, role: 'OWNER' } } },
    });
  }

  async create(userId: string, input: CreateWorkspaceInput): Promise<WorkspaceSummary> {
    const owned = await this.prisma.membership.count({ where: { userId, role: 'OWNER' } });
    if (owned >= MAX_WORKSPACES_PER_USER) {
      throw ApiException.badRequest(`You can own at most ${MAX_WORKSPACES_PER_USER} workspaces`);
    }
    const ws = await this.prisma.workspace.create({
      data: { name: input.name, slug: slugify(input.name), memberships: { create: { userId, role: 'OWNER' } } },
    });
    return { id: ws.id, name: ws.name, slug: ws.slug, role: 'OWNER', createdAt: ws.createdAt.toISOString() };
  }

  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
      createdAt: m.workspace.createdAt.toISOString(),
    }));
  }

  /** Always scoped: caller passes the workspace already authorized by WorkspaceGuard. */
  async get(workspaceId: string, role: WorkspaceRole): Promise<WorkspaceSummary> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw ApiException.notFound('Workspace');
    return { id: ws.id, name: ws.name, slug: ws.slug, role, createdAt: ws.createdAt.toISOString() };
  }

  async update(workspaceId: string, role: WorkspaceRole, input: UpdateWorkspaceInput): Promise<WorkspaceSummary> {
    const ws = await this.prisma.workspace.update({ where: { id: workspaceId }, data: { name: input.name } });
    return { id: ws.id, name: ws.name, slug: ws.slug, role, createdAt: ws.createdAt.toISOString() };
  }

  /** Deletes everything in the workspace. Stops live triggers first (schedulers, provider hooks). */
  async delete(workspaceId: string): Promise<void> {
    const zaps = await this.prisma.zap.findMany({ where: { workspaceId, status: 'ACTIVE' }, select: { id: true } });
    for (const z of zaps) await this.triggers.deactivate({ id: z.id, workspaceId });
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
  }
}
