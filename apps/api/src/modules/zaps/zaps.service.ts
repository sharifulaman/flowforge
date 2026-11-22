import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@flowforge/db';
import type { TriggerManager } from '@flowforge/engine';
import type { CreateZapInput, ListZapsQuery, Paginated, UpdateZapInput, ZapDetailDto, ZapSummaryDto } from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';
import { paginate } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';
import { TRIGGER_MANAGER } from '../../runtime/tokens';
import { toZapDetail, toZapSummary, zapDetailInclude, type ZapWithRelations } from './zap-mapper';

export const MAX_ZAPS_PER_WORKSPACE = 500;

@Injectable()
export class ZapsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRIGGER_MANAGER) private readonly triggers: TriggerManager,
  ) {}

  /** Tenant-scoped lookup; soft-deleted zaps are invisible. */
  async findOrThrow(workspaceId: string, zapId: string): Promise<ZapWithRelations> {
    const zap = await this.prisma.zap.findFirst({ where: { id: zapId, workspaceId, deletedAt: null }, include: zapDetailInclude });
    if (!zap) throw ApiException.notFound('Zap');
    return zap;
  }

  async detail(workspaceId: string, zapId: string): Promise<ZapDetailDto> {
    return toZapDetail(await this.findOrThrow(workspaceId, zapId), this.triggers);
  }

  async list(workspaceId: string, q: ListZapsQuery): Promise<Paginated<ZapSummaryDto>> {
    const where: Prisma.ZapWhereInput = {
      workspaceId,
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const rows = await this.prisma.zap.findMany({
      where,
      include: { steps: { select: { appKey: true, type: true, position: true } }, publishedVersion: { select: { version: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = paginate(rows, q.limit);
    return { items: page.items.map(toZapSummary), nextCursor: page.nextCursor };
  }

  async create(workspaceId: string, userId: string, input: CreateZapInput): Promise<ZapDetailDto> {
    const count = await this.prisma.zap.count({ where: { workspaceId, deletedAt: null } });
    if (count >= MAX_ZAPS_PER_WORKSPACE) throw ApiException.badRequest(`A workspace can have at most ${MAX_ZAPS_PER_WORKSPACE} Zaps`);
    const zap = await this.prisma.zap.create({
      data: { workspaceId, name: input.name, description: input.description, createdById: userId },
      include: zapDetailInclude,
    });
    return toZapDetail(zap, this.triggers);
  }

  async update(workspaceId: string, zapId: string, input: UpdateZapInput): Promise<ZapDetailDto> {
    await this.findOrThrow(workspaceId, zapId);
    const zap = await this.prisma.zap.update({
      where: { id: zapId },
      data: { name: input.name, description: input.description },
      include: zapDetailInclude,
    });
    return toZapDetail(zap, this.triggers);
  }

  /** Soft delete: stops triggers, keeps run history for auditing. */
  async delete(workspaceId: string, zapId: string): Promise<void> {
    const zap = await this.findOrThrow(workspaceId, zapId);
    await this.triggers.deactivate({ id: zap.id, workspaceId });
    await this.prisma.$transaction([
      this.prisma.zap.update({ where: { id: zapId }, data: { deletedAt: new Date(), status: 'PAUSED' } }),
      // Free the public URL so it stops resolving.
      this.prisma.triggerState.updateMany({ where: { zapId }, data: { hookToken: null } }),
    ]);
  }

  /** Copy the draft (steps, config, samples) into a new DRAFT zap. */
  async duplicate(workspaceId: string, zapId: string, userId: string): Promise<ZapDetailDto> {
    const src = await this.findOrThrow(workspaceId, zapId);
    const copy = await this.prisma.zap.create({
      data: {
        workspaceId,
        name: `Copy of ${src.name}`.slice(0, 120),
        description: src.description,
        createdById: userId,
        nextStepNumber: src.nextStepNumber,
        steps: {
          create: src.steps.map((s) => ({
            workspaceId,
            key: s.key,
            type: s.type,
            position: s.position,
            name: s.name,
            appKey: s.appKey,
            operationKey: s.operationKey,
            connectionId: s.connectionId,
            config: s.config as Prisma.InputJsonValue,
            timeoutMs: s.timeoutMs,
            sampleOutput: (s.sampleOutput ?? undefined) as Prisma.InputJsonValue | undefined,
            sampleAt: s.sampleAt,
          })),
        },
      },
      include: zapDetailInclude,
    });
    return toZapDetail(copy, this.triggers);
  }
}
