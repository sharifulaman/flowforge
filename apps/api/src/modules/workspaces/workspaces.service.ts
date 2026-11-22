import { Injectable } from '@nestjs/common';
import type { Prisma, Workspace } from '@flowforge/db';
import type { WorkspaceRole } from '@flowforge/shared';
import { randomBytes } from 'node:crypto';
import { ApiException } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';

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

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a workspace owned by `userId`. Runs inside the caller's transaction. */
  createPersonal(tx: Prisma.TransactionClient, userId: string, ownerName: string): Promise<Workspace> {
    const name = `${ownerName.split(' ')[0] || 'My'}'s Workspace`;
    return tx.workspace.create({
      data: {
        name,
        slug: slugify(name),
        memberships: { create: { userId, role: 'OWNER' } },
      },
    });
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
}
