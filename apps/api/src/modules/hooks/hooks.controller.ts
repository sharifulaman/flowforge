import { All, Controller, HttpStatus, Inject, Param, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ConnectorRegistry } from '@flowforge/connector-sdk';
import type { CredentialStore, RunLauncher } from '@flowforge/engine';
import { ErrorCode, type ZapDefinition } from '@flowforge/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiException } from '../../common/api-exception';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { CONNECTOR_REGISTRY, CREDENTIAL_STORE, RUN_LAUNCHER } from '../../runtime/tokens';
import { HOOK_TOKEN_RE, idempotencyKeyFrom, queryRecord, safeHeaders, toInbound } from './inbound';

const MAX_EVENTS_PER_DELIVERY = 100;

/**
 * Public inbound endpoints (mounted outside /api/v1):
 *   ANY  /hooks/:token       — catch hook for "Webhooks → Catch Hook" triggers
 *   POST /hooks/app/:token   — provider deliveries for app-event triggers
 */
@Public()
@Controller('hooks')
@Throttle({ default: { limit: 300, ttl: 60_000 } })
export class HooksController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUN_LAUNCHER) private readonly launcher: RunLauncher,
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(CREDENTIAL_STORE) private readonly credentials: CredentialStore,
  ) {}

  private async loadState(token: string, kind: 'webhook' | 'app_event') {
    if (!HOOK_TOKEN_RE.test(token)) throw ApiException.notFound('Webhook');
    const state = await this.prisma.triggerState.findUnique({
      where: { hookToken: token },
      include: { zap: { select: { id: true, workspaceId: true, status: true, deletedAt: true, publishedVersionId: true, publishedVersion: { select: { definition: true } } } } },
    });
    if (!state || state.kind !== kind || state.zap.deletedAt) throw ApiException.notFound('Webhook');
    return state;
  }

  @All('app/:token')
  async appEvent(@Param('token') token: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const state = await this.loadState(token, 'app_event');
    const zap = state.zap;
    // Providers retry (and sometimes disable hooks) on non-2xx, so acknowledge but ignore.
    if (zap.status !== 'ACTIVE' || !zap.publishedVersionId || !zap.publishedVersion) {
      return void reply.status(200).send({ ignored: true, reason: 'zap_inactive' });
    }
    const def = zap.publishedVersion.definition as unknown as ZapDefinition;
    const trigger = this.registry.getTrigger(def.trigger.appKey, def.trigger.operationKey);
    if (trigger?.kind !== 'app_webhook') throw ApiException.notFound('Webhook');

    const inbound = toInbound(req);
    const subscription = (state.subscription as { data?: unknown } | null)?.data ?? null;
    if (trigger.verify) {
      const auth = def.trigger.connectionId ? await this.credentials.getAuth(zap.workspaceId, def.trigger.connectionId) : {};
      const ok = await Promise.resolve(trigger.verify(inbound, { auth, subscription, input: def.trigger.config })).catch(() => false);
      if (!ok) throw ApiException.unauthenticated('Invalid webhook signature');
    }

    const items = (await trigger.parse(inbound)).slice(0, MAX_EVENTS_PER_DELIVERY);
    const runIds: string[] = [];
    for (const item of items) {
      const { runId } = await this.launcher.launch({
        workspaceId: zap.workspaceId,
        zapId: zap.id,
        zapVersionId: zap.publishedVersionId,
        source: 'APP_EVENT',
        triggerOutput: item.data,
        idempotencyKey: `app:${item.id}`,
      });
      runIds.push(runId);
    }
    this.touch(zap.id);
    return void reply.status(200).send({ received: items.length, runIds });
  }

  @All(':token')
  async catchHook(@Param('token') token: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const state = await this.loadState(token, 'webhook');
    const zap = state.zap;
    if (zap.status !== 'ACTIVE' || !zap.publishedVersionId) {
      throw new ApiException(HttpStatus.CONFLICT, ErrorCode.ZAP_INACTIVE, 'This Zap is turned off');
    }

    const senderKey = idempotencyKeyFrom(req);
    let result;
    try {
      result = await this.launcher.launch({
        workspaceId: zap.workspaceId,
        zapId: zap.id,
        zapVersionId: zap.publishedVersionId,
        source: 'WEBHOOK',
        triggerOutput: {
          method: req.method,
          body: req.body ?? null,
          query: queryRecord(req),
          headers: safeHeaders(req),
          receivedAt: new Date().toISOString(),
        },
        // Without a sender key every request is a distinct event (never silently dropped).
        idempotencyKey: senderKey ? `hdr:${senderKey}` : `req:${req.id}`,
      });
    } catch (err) {
      if (err instanceof RangeError) throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, ErrorCode.BAD_REQUEST, err.message);
      throw err;
    }
    this.touch(zap.id);
    return void reply
      .status(result.duplicate ? 200 : 202)
      .send({ status: result.duplicate ? 'duplicate' : 'accepted', runId: result.runId });
  }

  private touch(zapId: string): void {
    void this.prisma.triggerState.update({ where: { zapId }, data: { lastFiredAt: new Date() } }).catch(() => undefined);
  }
}
