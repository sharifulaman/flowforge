import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ConnectorRegistry } from '@flowforge/connector-sdk';
import { Prisma } from '@flowforge/db';
import {
  buildDefinition,
  type ConnectionRef,
  definitionsEqual,
  type RunLauncher,
  type TriggerManager,
  TriggerSetupError,
  validateForPublish,
} from '@flowforge/engine';
import { ErrorCode, type ManualRunInput, type ZapDefinition, type ZapDetailDto, type ZapVersionDto } from '@flowforge/shared';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../../common/api-exception';
import { iso } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';
import { CONNECTOR_REGISTRY, RUN_LAUNCHER, TRIGGER_MANAGER } from '../../runtime/tokens';
import { sortedSteps, toDraftSteps, toZapDetail, zapDetailInclude } from './zap-mapper';
import { ZapsService } from './zaps.service';

@Injectable()
export class ZapLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zaps: ZapsService,
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(TRIGGER_MANAGER) private readonly triggers: TriggerManager,
    @Inject(RUN_LAUNCHER) private readonly launcher: RunLauncher,
  ) {}

  /**
   * Validate the draft, publish it as a new immutable version (if it changed) and turn the
   * trigger on. Re-enabling an unchanged zap reuses the current version.
   */
  async enable(workspaceId: string, zapId: string, userId: string): Promise<ZapDetailDto> {
    const zap = await this.zaps.findOrThrow(workspaceId, zapId);
    const drafts = toDraftSteps(sortedSteps(zap.steps));

    const connections = new Map<string, ConnectionRef>(
      (
        await this.prisma.connection.findMany({
          where: { workspaceId, id: { in: drafts.map((s) => s.connectionId).filter((id): id is string => !!id) } },
          select: { id: true, appKey: true, status: true },
        })
      ).map((c) => [c.id, c]),
    );
    const issues = validateForPublish(drafts, this.registry, connections);
    if (issues.length) {
      throw ApiException.validation(
        issues.map((i) => ({ path: [i.stepKey ?? 'zap', i.field].filter(Boolean).join('.'), message: i.message })),
      );
    }

    const def = buildDefinition(drafts);
    const previous = (zap.publishedVersion?.definition as ZapDefinition | undefined) ?? null;
    const changed = !definitionsEqual(def, previous);

    try {
      await this.triggers.activate({ id: zap.id, workspaceId }, def, previous);
    } catch (err) {
      if (err instanceof TriggerSetupError) {
        throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.TRIGGER_SETUP_FAILED, err.message);
      }
      throw err;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Zap" WHERE id = ${zapId} FOR UPDATE`;
        let versionId = zap.publishedVersionId;
        if (changed || !versionId) {
          const last = await tx.zapVersion.findFirst({ where: { zapId }, orderBy: { version: 'desc' }, select: { version: true } });
          const v = await tx.zapVersion.create({
            data: {
              zapId,
              workspaceId,
              version: (last?.version ?? 0) + 1,
              definition: def as unknown as Prisma.InputJsonValue,
              createdById: userId,
            },
          });
          versionId = v.id;
        }
        await tx.zap.update({ where: { id: zapId }, data: { status: 'ACTIVE', publishedVersionId: versionId } });
      });
    } catch (err) {
      // Roll back side effects if we were not live before.
      if (zap.status !== 'ACTIVE') await this.triggers.deactivate({ id: zap.id, workspaceId }).catch(() => undefined);
      throw err;
    }
    return this.detail(workspaceId, zapId);
  }

  async disable(workspaceId: string, zapId: string): Promise<ZapDetailDto> {
    const zap = await this.zaps.findOrThrow(workspaceId, zapId);
    await this.triggers.deactivate({ id: zap.id, workspaceId });
    await this.prisma.zap.update({ where: { id: zapId }, data: { status: zap.publishedVersionId ? 'PAUSED' : 'DRAFT' } });
    return this.detail(workspaceId, zapId);
  }

  async versions(workspaceId: string, zapId: string): Promise<ZapVersionDto[]> {
    const zap = await this.zaps.findOrThrow(workspaceId, zapId);
    const rows = await this.prisma.zapVersion.findMany({
      where: { zapId, workspaceId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, createdAt: true, createdById: true },
    });
    return rows.map((v) => ({ ...v, createdAt: iso(v.createdAt)!, isPublished: v.id === zap.publishedVersionId }));
  }

  /** Run the published version now, with a supplied payload or the trigger's sample data. */
  async runNow(workspaceId: string, zapId: string, input: ManualRunInput): Promise<{ runId: string }> {
    const zap = await this.zaps.findOrThrow(workspaceId, zapId);
    if (!zap.publishedVersionId || !zap.publishedVersion) {
      throw ApiException.badRequest('Publish this Zap (turn it on) before running it');
    }
    const def = zap.publishedVersion.definition as unknown as ZapDefinition;
    const triggerStep = zap.steps.find((s) => s.type === 'TRIGGER');
    const payload =
      input.payload ??
      (triggerStep?.sampleOutput as Record<string, unknown> | null) ??
      this.registry.getTrigger(def.trigger.appKey, def.trigger.operationKey)?.sampleOutput ??
      {};
    const { runId } = await this.launcher.launch({
      workspaceId,
      zapId,
      zapVersionId: zap.publishedVersionId,
      source: 'MANUAL',
      triggerOutput: payload,
      idempotencyKey: `manual:${randomUUID()}`,
    });
    return { runId };
  }

  async rotateHookToken(workspaceId: string, zapId: string): Promise<ZapDetailDto> {
    const zap = await this.zaps.findOrThrow(workspaceId, zapId);
    if (!zap.triggerState?.hookToken) throw ApiException.badRequest('This Zap has no webhook URL');
    await this.triggers.rotateHookToken(zapId);
    return this.detail(workspaceId, zapId);
  }

  private async detail(workspaceId: string, zapId: string): Promise<ZapDetailDto> {
    const zap = await this.prisma.zap.findFirstOrThrow({ where: { id: zapId, workspaceId }, include: zapDetailInclude });
    return toZapDetail(zap, this.triggers);
  }
}
