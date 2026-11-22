import { Injectable } from '@nestjs/common';
import type { Role } from '@flowforge/db';
import type { AddMemberInput, MemberDto, UpdateMemberInput } from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';
import { iso } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';
import type { WorkspaceContext } from '../../types/principal';

type MembershipWithUser = {
  id: string;
  userId: string;
  role: Role;
  createdAt: Date;
  user: { email: string; name: string | null; avatarUrl: string | null };
};

function toDto(m: MembershipWithUser): MemberDto {
  return {
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    avatarUrl: m.user.avatarUrl,
    role: m.role,
    joinedAt: iso(m.createdAt)!,
  };
}

const userSelect = { select: { email: true, name: true, avatarUrl: true } } as const;

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string): Promise<MemberDto[]> {
    const rows = await this.prisma.membership.findMany({
      where: { workspaceId },
      include: { user: userSelect },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toDto);
  }

  /** Adds an existing FlowForge user. (Email invitations are out of MVP scope.) */
  async add(ws: WorkspaceContext, input: AddMemberInput): Promise<MemberDto> {
    if (input.role === 'OWNER' && ws.role !== 'OWNER') throw ApiException.forbidden('Only owners can add owners');
    const user = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (!user) throw new ApiException(404, 'NOT_FOUND', 'No FlowForge account uses that email. Ask them to sign up first.');
    const exists = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } },
    });
    if (exists) throw ApiException.conflict('That user is already a member');
    const m = await this.prisma.membership.create({
      data: { workspaceId: ws.id, userId: user.id, role: input.role },
      include: { user: userSelect },
    });
    return toDto(m);
  }

  async update(ws: WorkspaceContext, memberId: string, input: UpdateMemberInput): Promise<MemberDto> {
    const target = await this.find(ws.id, memberId);
    // Only owners may create or demote owners.
    if ((input.role === 'OWNER' || target.role === 'OWNER') && ws.role !== 'OWNER') {
      throw ApiException.forbidden('Only owners can change owner roles');
    }
    if (target.role === 'OWNER' && input.role !== 'OWNER') await this.assertNotLastOwner(ws.id);
    const m = await this.prisma.membership.update({
      where: { id: target.id },
      data: { role: input.role },
      include: { user: userSelect },
    });
    return toDto(m);
  }

  /** Admins remove members; anyone can remove themselves (leave). */
  async remove(ws: WorkspaceContext, memberId: string, actingUserId: string): Promise<void> {
    const target = await this.find(ws.id, memberId);
    const isSelf = target.userId === actingUserId;
    if (!isSelf && ws.role === 'MEMBER') throw ApiException.forbidden('Only admins can remove members');
    if (target.role === 'OWNER' && !isSelf && ws.role !== 'OWNER') throw ApiException.forbidden('Only owners can remove owners');
    if (target.role === 'OWNER') await this.assertNotLastOwner(ws.id);
    await this.prisma.membership.delete({ where: { id: target.id } });
  }

  private async find(workspaceId: string, memberId: string) {
    const m = await this.prisma.membership.findFirst({ where: { id: memberId, workspaceId } });
    if (!m) throw ApiException.notFound('Member');
    return m;
  }

  private async assertNotLastOwner(workspaceId: string): Promise<void> {
    const owners = await this.prisma.membership.count({ where: { workspaceId, role: 'OWNER' } });
    if (owners <= 1) throw ApiException.conflict('A workspace must keep at least one owner');
  }
}
