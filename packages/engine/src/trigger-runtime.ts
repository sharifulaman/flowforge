import type { ConnectorLogger, ConnectorRegistry, PolledItem } from '@flowforge/connector-sdk';
import { Prisma, type PrismaClient } from '@flowforge/db';
import type { TriggerJobData, ZapDefinition } from '@flowforge/shared';
import type { CredentialStore } from './credentials';
import { classifyError } from './errors';
import type { SafeHttpClient } from '@flowforge/safe-http';
import type { RunLauncher } from './run-launcher';
import type { TriggerManager } from './trigger-manager';

export const MAX_ITEMS_PER_POLL = 100;
export const POLL_TIMEOUT_MS = 60_000;

export interface TriggerRuntimeDeps {
  prisma: PrismaClient;
  registry: ConnectorRegistry;
  credentials: CredentialStore;
  http: SafeHttpClient;
  launcher: RunLauncher;
  triggers: TriggerManager;
  logger: ConnectorLogger;
  now?: () => number;
}

export type FireResult = { launched: string[]; skipped?: 'inactive' | 'baseline' };

/** Executes schedule ticks and polling cycles (called by the worker's trigger processor). */
export class TriggerRuntime {
  private readonly now: () => number;
  constructor(private readonly d: TriggerRuntimeDeps) {
    this.now = d.now ?? Date.now;
  }

  private async activeZap(data: TriggerJobData) {
    const zap = await this.d.prisma.zap.findFirst({
      where: { id: data.zapId, workspaceId: data.workspaceId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, workspaceId: true, publishedVersionId: true, publishedVersion: { select: { definition: true } } },
    });
    if (!zap?.publishedVersionId || !zap.publishedVersion) return null;
    return { ...zap, publishedVersionId: zap.publishedVersionId, def: zap.publishedVersion.definition as unknown as ZapDefinition };
  }

  /** One schedule tick. `fireId` must be unique per tick (BullMQ repeat job id) → idempotent. */
  async fireSchedule(data: TriggerJobData, fireId: string, scheduledFor: Date): Promise<FireResult> {
    const zap = await this.activeZap(data);
    if (!zap) return { launched: [], skipped: 'inactive' };
    const timezone = String((zap.def.trigger.config as { timezone?: string }).timezone ?? 'UTC');
    const { runId } = await this.d.launcher.launch({
      workspaceId: zap.workspaceId,
      zapId: zap.id,
      zapVersionId: zap.publishedVersionId,
      source: 'SCHEDULE',
      triggerOutput: { firedAt: new Date(this.now()).toISOString(), scheduledFor: scheduledFor.toISOString(), timezone },
      idempotencyKey: `sched:${fireId}`,
    });
    await this.d.prisma.triggerState.updateMany({ where: { zapId: zap.id }, data: { lastFiredAt: new Date(this.now()) } });
    return { launched: [runId] };
  }

  /**
   * One polling cycle. The very first poll only records a baseline (existing items are not
   * treated as new). Afterwards, unseen item ids start runs in the order the connector returned
   * them (connectors return oldest first).
   */
  async poll(data: TriggerJobData): Promise<FireResult> {
    const zap = await this.activeZap(data);
    if (!zap) return { launched: [], skipped: 'inactive' };
    const t = zap.def.trigger;
    const trigger = this.d.registry.getTrigger(t.appKey, t.operationKey);
    if (trigger?.kind !== 'polling') return { launched: [], skipped: 'inactive' };

    const state = await this.d.prisma.triggerState.findUnique({ where: { zapId: zap.id } });
    const firstPoll = !state?.lastPolledAt;

    let items: PolledItem[];
    let cursor: unknown;
    try {
      const auth = t.connectionId ? await this.d.credentials.getAuth(zap.workspaceId, t.connectionId) : {};
      const signal = AbortSignal.timeout(POLL_TIMEOUT_MS);
      const res = await trigger.poll({
        input: t.config,
        cursor: state?.cursor ?? undefined,
        auth,
        http: this.d.http.withSignal(signal),
        logger: this.d.logger,
        signal,
        workspaceId: zap.workspaceId,
        zapId: zap.id,
      });
      items = res.items.slice(0, MAX_ITEMS_PER_POLL);
      cursor = res.cursor;
    } catch (err) {
      const c = classifyError(err);
      const message = 'error' in c ? c.error.message : String(err);
      await this.d.prisma.triggerState.updateMany({ where: { zapId: zap.id }, data: { lastError: message.slice(0, 500), lastPolledAt: new Date(this.now()) } });
      if (c.kind === 'auth') {
        // Polling with dead credentials would fail forever: switch the zap off and say why.
        await this.d.triggers.deactivate({ id: zap.id, workspaceId: zap.workspaceId });
        await this.d.prisma.zap.update({ where: { id: zap.id }, data: { status: 'ERROR' } });
      }
      throw err;
    }

    const fresh = await this.recordSeen(zap.id, items.map((i) => i.id));
    const launched: string[] = [];
    if (!firstPoll) {
      for (const item of items.filter((i) => fresh.has(i.id))) {
        const { runId } = await this.d.launcher.launch({
          workspaceId: zap.workspaceId,
          zapId: zap.id,
          zapVersionId: zap.publishedVersionId,
          source: 'POLL',
          triggerOutput: item.data,
          idempotencyKey: `poll:${item.id}`,
        });
        launched.push(runId);
      }
    }
    await this.d.prisma.triggerState.updateMany({
      where: { zapId: zap.id },
      data: {
        lastPolledAt: new Date(this.now()),
        lastError: null,
        ...(cursor !== undefined ? { cursor: cursor as Prisma.InputJsonValue } : {}),
        ...(launched.length ? { lastFiredAt: new Date(this.now()) } : {}),
      },
    });
    return firstPoll ? { launched, skipped: 'baseline' } : { launched };
  }

  /** Insert ids into PollDedupe; returns the ones that were not seen before. */
  private async recordSeen(zapId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.d.prisma.$queryRaw<Array<{ itemKey: string }>>`
      INSERT INTO "PollDedupe" ("zapId", "itemKey", "createdAt")
      SELECT ${zapId}, k, now() FROM unnest(${ids}::text[]) AS k
      ON CONFLICT DO NOTHING
      RETURNING "itemKey"`;
    return new Set(rows.map((r) => r.itemKey));
  }
}
