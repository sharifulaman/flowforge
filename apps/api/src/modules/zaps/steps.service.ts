import { Inject, Injectable } from '@nestjs/common';
import type { ConnectorRegistry, DefinedApp } from '@flowforge/connector-sdk';
import { Prisma } from '@flowforge/db';
import type { TriggerManager } from '@flowforge/engine';
import type { AddStepInput, ReorderStepsInput, SetTriggerInput, UpdateStepInput, ZapDetailDto } from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { CONNECTOR_REGISTRY, TRIGGER_MANAGER } from '../../runtime/tokens';
import { MAX_ACTIONS } from '@flowforge/engine';
import { toZapDetail, zapDetailInclude } from './zap-mapper';

type Tx = Prisma.TransactionClient;

/**
 * Draft editing. Every mutation runs in a transaction holding a row lock on the zap, so
 * concurrent edits (two tabs, API scripts) can't corrupt step keys or positions.
 * The published version is never touched here.
 */
@Injectable()
export class StepsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(TRIGGER_MANAGER) private readonly triggers: TriggerManager,
  ) {}

  async setTrigger(workspaceId: string, zapId: string, input: SetTriggerInput): Promise<ZapDetailDto> {
    const app = this.requireApp(input.appKey);
    const trigger = this.registry.getTrigger(input.appKey, input.operationKey);
    if (!trigger) throw ApiException.badRequest(`${app.name} has no trigger "${input.operationKey}"`);
    const connectionId = await this.resolveConnection(workspaceId, app, input.connectionId);

    await this.mutate(workspaceId, zapId, async (tx) => {
      const existing = await tx.zapStep.findFirst({ where: { zapId, type: 'TRIGGER' } });
      const opChanged = !existing || existing.appKey !== input.appKey || existing.operationKey !== input.operationKey;
      const data = {
        appKey: input.appKey,
        operationKey: input.operationKey,
        connectionId,
        config: input.config as Prisma.InputJsonValue,
        name: input.name ?? null,
        ...(opChanged ? { sampleOutput: Prisma.DbNull, sampleAt: null } : {}),
      };
      if (existing) await tx.zapStep.update({ where: { id: existing.id }, data });
      else await tx.zapStep.create({ data: { ...data, zapId, workspaceId, key: 'trigger', type: 'TRIGGER', position: 0 } });
    });

    // Show the webhook URL in the builder before the zap is published.
    if (trigger.kind === 'webhook') await this.triggers.ensureHookToken({ id: zapId, workspaceId }, 'webhook');
    return this.detail(workspaceId, zapId);
  }

  async addStep(workspaceId: string, zapId: string, input: AddStepInput): Promise<ZapDetailDto> {
    const app = this.requireApp(input.appKey);
    if (!this.registry.getAction(input.appKey, input.operationKey)) {
      throw ApiException.badRequest(`${app.name} has no action "${input.operationKey}"`);
    }
    const connectionId = await this.resolveConnection(workspaceId, app, input.connectionId);

    await this.mutate(workspaceId, zapId, async (tx) => {
      const actions = await tx.zapStep.findMany({ where: { zapId, type: 'ACTION' }, orderBy: { position: 'asc' } });
      if (actions.length >= MAX_ACTIONS) throw ApiException.badRequest(`A Zap can have at most ${MAX_ACTIONS} actions`);

      let position = (actions[actions.length - 1]?.position ?? 0) + 1;
      if (input.afterKey !== undefined) {
        const after = input.afterKey === 'trigger' ? 0 : actions.find((a) => a.key === input.afterKey)?.position;
        if (after === undefined) throw ApiException.badRequest(`No step "${input.afterKey}" in this Zap`);
        position = after + 1;
        await this.shift(tx, zapId, position);
      }

      // Monotonic counter → keys are never reused, so old references can't silently re-point.
      const { nextStepNumber } = await tx.zap.update({ where: { id: zapId }, data: { nextStepNumber: { increment: 1 } } });
      await tx.zapStep.create({
        data: {
          zapId,
          workspaceId,
          key: `step${nextStepNumber - 1}`,
          type: 'ACTION',
          position,
          name: input.name ?? null,
          appKey: input.appKey,
          operationKey: input.operationKey,
          connectionId,
          config: input.config as Prisma.InputJsonValue,
          timeoutMs: input.timeoutMs ?? null,
        },
      });
    });
    return this.detail(workspaceId, zapId);
  }

  async updateStep(workspaceId: string, zapId: string, stepId: string, input: UpdateStepInput): Promise<ZapDetailDto> {
    await this.mutate(workspaceId, zapId, async (tx) => {
      const step = await tx.zapStep.findFirst({ where: { id: stepId, zapId } });
      if (!step) throw ApiException.notFound('Step');

      const appKey = input.appKey ?? step.appKey;
      const operationKey = input.operationKey ?? step.operationKey;
      const app = this.requireApp(appKey);
      const op = step.type === 'TRIGGER' ? this.registry.getTrigger(appKey, operationKey) : this.registry.getAction(appKey, operationKey);
      if (!op) throw ApiException.badRequest(`${app.name} has no ${step.type === 'TRIGGER' ? 'trigger' : 'action'} "${operationKey}"`);

      const opChanged = appKey !== step.appKey || operationKey !== step.operationKey;
      let connectionId = step.connectionId;
      if (input.connectionId !== undefined) connectionId = await this.resolveConnection(workspaceId, app, input.connectionId);
      else if (appKey !== step.appKey) connectionId = null; // old app's account can't be reused

      await tx.zapStep.update({
        where: { id: step.id },
        data: {
          appKey,
          operationKey,
          connectionId,
          ...(input.config !== undefined ? { config: input.config as Prisma.InputJsonValue } : opChanged ? { config: {} } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(opChanged ? { sampleOutput: Prisma.DbNull, sampleAt: null } : {}),
        },
      });
    });
    return this.detail(workspaceId, zapId);
  }

  async deleteStep(workspaceId: string, zapId: string, stepId: string): Promise<ZapDetailDto> {
    await this.mutate(workspaceId, zapId, async (tx) => {
      const step = await tx.zapStep.findFirst({ where: { id: stepId, zapId } });
      if (!step) throw ApiException.notFound('Step');
      await tx.zapStep.delete({ where: { id: step.id } });
      if (step.type === 'ACTION') await this.compact(tx, zapId);
    });
    return this.detail(workspaceId, zapId);
  }

  /** `order` must contain every action id exactly once. */
  async reorder(workspaceId: string, zapId: string, input: ReorderStepsInput): Promise<ZapDetailDto> {
    await this.mutate(workspaceId, zapId, async (tx) => {
      const actions = await tx.zapStep.findMany({ where: { zapId, type: 'ACTION' }, select: { id: true } });
      const ids = new Set(actions.map((a) => a.id));
      if (input.order.length !== ids.size || new Set(input.order).size !== ids.size || !input.order.every((id) => ids.has(id))) {
        throw ApiException.badRequest('order must list every action step exactly once');
      }
      // Two passes avoid transient duplicate positions.
      await tx.zapStep.updateMany({ where: { zapId, type: 'ACTION' }, data: { position: { increment: 10_000 } } });
      for (const [i, id] of input.order.entries()) {
        await tx.zapStep.update({ where: { id }, data: { position: i + 1 } });
      }
    });
    return this.detail(workspaceId, zapId);
  }

  // ─── helpers ─────────────────────────────────────────────

  private async detail(workspaceId: string, zapId: string): Promise<ZapDetailDto> {
    const zap = await this.prisma.zap.findFirstOrThrow({ where: { id: zapId, workspaceId }, include: zapDetailInclude });
    return toZapDetail(zap, this.triggers);
  }

  private async mutate(workspaceId: string, zapId: string, fn: (tx: Tx) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Zap" WHERE id = ${zapId} AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (!locked.length) throw ApiException.notFound('Zap');
      await fn(tx);
      await tx.zap.update({ where: { id: zapId }, data: { updatedAt: new Date() } });
    });
  }

  private requireApp(appKey: string): DefinedApp {
    const app = this.registry.get(appKey);
    if (!app) throw ApiException.badRequest(`Unknown app "${appKey}"`);
    return app;
  }

  /** Connections must belong to this workspace and app; apps without auth never take one. */
  private async resolveConnection(workspaceId: string, app: DefinedApp, connectionId: string | null | undefined): Promise<string | null> {
    if (app.auth.type === 'none' || !connectionId) return null;
    const conn = await this.prisma.connection.findFirst({ where: { id: connectionId, workspaceId }, select: { appKey: true } });
    if (!conn) throw ApiException.badRequest('Connection not found in this workspace');
    if (conn.appKey !== app.key) throw ApiException.badRequest(`That connection is for ${conn.appKey}, not ${app.name}`);
    return connectionId;
  }

  private async shift(tx: Tx, zapId: string, fromPosition: number): Promise<void> {
    await tx.zapStep.updateMany({ where: { zapId, type: 'ACTION', position: { gte: fromPosition } }, data: { position: { increment: 1 } } });
  }

  private async compact(tx: Tx, zapId: string): Promise<void> {
    const actions = await tx.zapStep.findMany({ where: { zapId, type: 'ACTION' }, orderBy: { position: 'asc' }, select: { id: true, position: true } });
    for (const [i, a] of actions.entries()) {
      if (a.position !== i + 1) await tx.zapStep.update({ where: { id: a.id }, data: { position: i + 1 } });
    }
  }
}
