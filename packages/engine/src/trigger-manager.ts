import type { ConnectorLogger, ConnectorRegistry, HttpClient } from '@flowforge/connector-sdk';
import { Prisma, type PrismaClient } from '@flowforge/db';
import { triggerSchedulerId, type TriggerJobData, type ZapDefinition } from '@flowforge/shared';
import { randomToken } from '@flowforge/shared/node';
import type { Queue } from 'bullmq';
import { canonicalJson } from './canonical-json';
import type { CredentialStore } from './credentials';

export type TriggerStateKind = 'webhook' | 'schedule' | 'poll' | 'app_event';

export class TriggerSetupError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'TriggerSetupError';
  }
}

/** What we need to undo an app-webhook subscription later, even if the zap changes. */
interface StoredSubscription {
  appKey: string;
  operationKey: string;
  connectionId: string | null;
  input: Record<string, unknown>;
  data: unknown;
}

export interface TriggerManagerDeps {
  prisma: PrismaClient;
  triggersQueue: Queue<TriggerJobData>;
  registry: ConnectorRegistry;
  credentials: CredentialStore;
  http: HttpClient;
  logger: ConnectorLogger;
  /** Public base URL for inbound hooks, e.g. https://hooks.flowforge.dev */
  hooksBaseUrl: string;
}

/**
 * Owns trigger side-effects: webhook tokens, BullMQ job schedulers (schedule/poll), and
 * provider subscriptions (app webhooks). Idempotent: activating twice is safe.
 */
export class TriggerManager {
  constructor(private readonly d: TriggerManagerDeps) {}

  hookUrl(kind: string | null | undefined, token: string | null | undefined): string | null {
    if (!token) return null;
    const base = this.d.hooksBaseUrl.replace(/\/+$/, '');
    if (kind === 'webhook') return `${base}/hooks/${token}`;
    if (kind === 'app_event') return `${base}/hooks/app/${token}`;
    return null;
  }

  /** Make the published trigger live. Throws TriggerSetupError on provider/scheduler failures. */
  async activate(zap: { id: string; workspaceId: string }, def: ZapDefinition, previous?: ZapDefinition | null): Promise<void> {
    const t = def.trigger;
    const trigger = this.d.registry.getTrigger(t.appKey, t.operationKey);
    if (!trigger) throw new TriggerSetupError(`Unknown trigger ${t.appKey}.${t.operationKey}`);

    const existing = await this.d.prisma.triggerState.findUnique({ where: { zapId: zap.id } });
    const triggerChanged = !previous || canonicalJson(previous.trigger) !== canonicalJson(def.trigger);

    // Tear down anything from a previous, different trigger first.
    await this.removeScheduler(zap.id);
    if (existing?.subscription && triggerChanged) await this.unsubscribe(zap.workspaceId, existing.subscription as unknown as StoredSubscription);

    let kind: TriggerStateKind;
    let hookToken: string | null = existing?.hookToken ?? null;
    let subscription: StoredSubscription | null = triggerChanged ? null : ((existing?.subscription as unknown as StoredSubscription) ?? null);
    const config = t.config;

    switch (trigger.kind) {
      case 'webhook':
        kind = 'webhook';
        hookToken ??= randomToken(24);
        break;
      case 'schedule': {
        kind = 'schedule';
        const spec = trigger.schedule(config as never);
        await this.upsertScheduler(zap, 'schedule', 'cron' in spec ? { pattern: spec.cron, tz: spec.timezone } : { every: spec.everyMs });
        break;
      }
      case 'polling':
        kind = 'poll';
        await this.upsertScheduler(zap, 'poll', { every: trigger.intervalSeconds * 1000 });
        break;
      case 'app_webhook': {
        kind = 'app_event';
        hookToken ??= randomToken(24);
        if (!subscription) {
          const auth = t.connectionId ? await this.d.credentials.getAuth(zap.workspaceId, t.connectionId) : {};
          try {
            const data = await trigger.subscribe({
              auth,
              http: this.d.http,
              logger: this.d.logger,
              signal: AbortSignal.timeout(30_000),
              workspaceId: zap.workspaceId,
              input: config,
              webhookUrl: this.hookUrl('app_event', hookToken)!,
              zapId: zap.id,
            });
            subscription = { appKey: t.appKey, operationKey: t.operationKey, connectionId: t.connectionId, input: config, data: data ?? null };
          } catch (err) {
            throw new TriggerSetupError(`Could not register the trigger with ${t.appKey}: ${(err as Error).message}`, err);
          }
        }
        break;
      }
    }

    const resetCursor = triggerChanged || existing?.kind !== kind;
    await this.d.prisma.triggerState.upsert({
      where: { zapId: zap.id },
      create: {
        zapId: zap.id,
        workspaceId: zap.workspaceId,
        kind,
        hookToken,
        subscription: subscription ? (subscription as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
      update: {
        kind,
        hookToken,
        subscription: subscription ? (subscription as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        lastError: null,
        ...(resetCursor ? { cursor: Prisma.JsonNull, lastPolledAt: null } : {}),
      },
    });
  }

  /** Stop the trigger. Keeps the webhook token so the URL survives pause/resume. */
  async deactivate(zap: { id: string; workspaceId: string }): Promise<void> {
    await this.removeScheduler(zap.id);
    const state = await this.d.prisma.triggerState.findUnique({ where: { zapId: zap.id } });
    if (state?.subscription) {
      await this.unsubscribe(zap.workspaceId, state.subscription as unknown as StoredSubscription);
      await this.d.prisma.triggerState.update({ where: { zapId: zap.id }, data: { subscription: Prisma.JsonNull } });
    }
  }

  /** Ensure a webhook token exists (so the builder can show the URL before publishing). */
  async ensureHookToken(zap: { id: string; workspaceId: string }, kind: 'webhook' | 'app_event'): Promise<string> {
    const state = await this.d.prisma.triggerState.upsert({
      where: { zapId: zap.id },
      create: { zapId: zap.id, workspaceId: zap.workspaceId, kind, hookToken: randomToken(24) },
      update: {},
    });
    if (state.hookToken) return state.hookToken;
    const token = randomToken(24);
    await this.d.prisma.triggerState.update({ where: { zapId: zap.id }, data: { hookToken: token } });
    return token;
  }

  async rotateHookToken(zapId: string): Promise<string> {
    const token = randomToken(24);
    await this.d.prisma.triggerState.update({ where: { zapId }, data: { hookToken: token } });
    return token;
  }

  private async upsertScheduler(
    zap: { id: string; workspaceId: string },
    kind: 'schedule' | 'poll',
    repeat: { pattern: string; tz?: string } | { every: number },
  ): Promise<void> {
    try {
      await this.d.triggersQueue.upsertJobScheduler(triggerSchedulerId(zap.id), repeat, {
        name: kind,
        data: { zapId: zap.id, workspaceId: zap.workspaceId, kind },
        opts: { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
      });
    } catch (err) {
      throw new TriggerSetupError(`Could not schedule the trigger: ${(err as Error).message}`, err);
    }
  }

  private async removeScheduler(zapId: string): Promise<void> {
    await this.d.triggersQueue.removeJobScheduler(triggerSchedulerId(zapId));
  }

  /** Best effort: a provider that's down must not block pausing a zap. */
  private async unsubscribe(workspaceId: string, sub: StoredSubscription): Promise<void> {
    const trigger = this.d.registry.getTrigger(sub.appKey, sub.operationKey);
    if (trigger?.kind !== 'app_webhook') return;
    try {
      const auth = sub.connectionId ? await this.d.credentials.getAuth(workspaceId, sub.connectionId) : {};
      await trigger.unsubscribe(
        {
          auth,
          http: this.d.http,
          logger: this.d.logger,
          signal: AbortSignal.timeout(30_000),
          workspaceId,
          input: sub.input,
          webhookUrl: '',
          zapId: '',
        },
        sub.data,
      );
    } catch (err) {
      this.d.logger.warn('Failed to unsubscribe app webhook', { appKey: sub.appKey, error: (err as Error).message });
    }
  }
}
