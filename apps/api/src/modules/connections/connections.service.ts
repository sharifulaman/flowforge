import { Inject, Injectable } from '@nestjs/common';
import {
  type ConnectionInfo,
  type ConnectorRegistry,
  type DefinedApp,
  type OAuth2Credentials,
  validateInput,
} from '@flowforge/connector-sdk';
import type { Connection, ConnectionAuthType, Prisma } from '@flowforge/db';
import { type CredentialStore, type SafeHttpClient, silentConnectorLogger } from '@flowforge/engine';
import type { ConnectionDto, CreateConnectionInput, UpdateConnectionInput, ZapDefinition } from '@flowforge/shared';
import { ApiException } from '../../common/api-exception';
import { iso } from '../../common/serialize';
import { PrismaService } from '../../prisma/prisma.service';
import { CONNECTOR_REGISTRY, CREDENTIAL_STORE, SAFE_HTTP } from '../../runtime/tokens';
import { API_CONNECTOR_TIMEOUT_MS, connectorErrorToHttp } from '../apps/connector-context';

type ConnectionWithCount = Connection & { _count: { steps: number } };

const AUTH_TYPE: Record<string, ConnectionAuthType> = {
  api_key: 'API_KEY',
  basic: 'BASIC',
  custom: 'CUSTOM',
  oauth2: 'OAUTH2',
};

export function toConnectionDto(c: ConnectionWithCount): ConnectionDto {
  return {
    id: c.id,
    appKey: c.appKey,
    name: c.name,
    authType: c.authType,
    status: c.status,
    displayInfo: (c.displayInfo as Record<string, unknown> | null) ?? null,
    scopes: c.scopes,
    expiresAt: iso(c.expiresAt),
    lastUsedAt: iso(c.lastUsedAt),
    lastError: c.lastError,
    createdAt: iso(c.createdAt)!,
    updatedAt: iso(c.updatedAt)!,
    usedBySteps: c._count.steps,
  };
}

const withCount = { _count: { select: { steps: true } } } as const;

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(CREDENTIAL_STORE) private readonly credentials: CredentialStore,
    @Inject(SAFE_HTTP) private readonly http: SafeHttpClient,
  ) {}

  appOrThrow(appKey: string): DefinedApp {
    const app = this.registry.get(appKey);
    if (!app) throw ApiException.notFound('App');
    return app;
  }

  async list(workspaceId: string, appKey?: string): Promise<ConnectionDto[]> {
    const rows = await this.prisma.connection.findMany({
      where: { workspaceId, ...(appKey ? { appKey } : {}) },
      include: withCount,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toConnectionDto);
  }

  async get(workspaceId: string, id: string): Promise<ConnectionDto> {
    return toConnectionDto(await this.findOrThrow(workspaceId, id));
  }

  /** Create an API-key / basic / custom connection. Credentials are validated and tested first. */
  async create(workspaceId: string, userId: string, input: CreateConnectionInput): Promise<ConnectionDto> {
    const app = this.appOrThrow(input.appKey);
    const credentials = this.validateCredentials(app, input.credentials);
    const info = await this.runAuthTest(app, credentials);
    const name = input.name ?? (await this.defaultName(workspaceId, app, info));

    const row = await this.prisma.connection.create({
      data: {
        workspaceId,
        appKey: app.key,
        name,
        authType: AUTH_TYPE[app.auth.type]!,
        displayInfo: (info ?? undefined) as Prisma.InputJsonValue | undefined,
        createdById: userId,
        ...this.credentials.encrypt(workspaceId, app.key, credentials),
      },
      include: withCount,
    });
    return toConnectionDto(row);
  }

  async update(workspaceId: string, id: string, input: UpdateConnectionInput): Promise<ConnectionDto> {
    const existing = await this.findOrThrow(workspaceId, id);
    const data: Prisma.ConnectionUpdateInput = {};
    if (input.name) data.name = input.name;
    if (input.credentials) {
      const app = this.appOrThrow(existing.appKey);
      if (app.auth.type === 'oauth2') throw ApiException.badRequest('Reconnect OAuth accounts through the sign-in flow');
      const credentials = this.validateCredentials(app, input.credentials);
      const info = await this.runAuthTest(app, credentials);
      Object.assign(data, this.credentials.encrypt(workspaceId, app.key, credentials), {
        status: 'ACTIVE',
        lastError: null,
        displayInfo: (info ?? undefined) as Prisma.InputJsonValue | undefined,
      });
    }
    const row = await this.prisma.connection.update({ where: { id: existing.id }, data, include: withCount });
    return toConnectionDto(row);
  }

  /** Refuses while a live (published, active) zap depends on the connection. */
  async delete(workspaceId: string, id: string): Promise<void> {
    await this.findOrThrow(workspaceId, id);
    const live = await this.liveZapsUsing(workspaceId, id);
    if (live.length) {
      throw ApiException.conflict(`This account is used by active Zaps: ${live.map((z) => `"${z}"`).join(', ')}. Turn them off first.`);
    }
    await this.prisma.connection.delete({ where: { id } });
  }

  /** Re-run the app's credential test and update status/display info. */
  async test(workspaceId: string, id: string): Promise<ConnectionDto> {
    const conn = await this.findOrThrow(workspaceId, id);
    const app = this.appOrThrow(conn.appKey);
    try {
      const auth = await this.credentials.getAuth(workspaceId, id);
      const info = await this.runAuthTest(app, auth);
      const row = await this.prisma.connection.update({
        where: { id },
        data: { status: 'ACTIVE', lastError: null, ...(info ? { displayInfo: info as Prisma.InputJsonValue } : {}) },
        include: withCount,
      });
      return toConnectionDto(row);
    } catch (err) {
      const httpErr = connectorErrorToHttp(err, 'Connection test failed');
      await this.prisma.connection.update({
        where: { id },
        data: { status: conn.status === 'EXPIRED' ? 'EXPIRED' : 'ERROR', lastError: httpErr.message.slice(0, 500) },
      });
      throw httpErr;
    }
  }

  /** Store a new OAuth connection or refresh an existing one (reconnect). */
  async saveOAuth(
    p: { workspaceId: string; userId: string; app: DefinedApp; name?: string; connectionId?: string },
    tokens: OAuth2Credentials,
  ): Promise<Connection> {
    const info = await this.runAuthTest(p.app, tokens as unknown as Record<string, unknown>).catch(() => undefined);
    const common = {
      ...this.credentials.encrypt(p.workspaceId, p.app.key, tokens as unknown as Record<string, unknown>),
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
      scopes: (tokens.scope ?? '').split(/[ ,]+/).filter(Boolean),
      status: 'ACTIVE' as const,
      lastError: null,
      displayInfo: (info ?? undefined) as Prisma.InputJsonValue | undefined,
    };
    if (p.connectionId) {
      await this.findOrThrow(p.workspaceId, p.connectionId);
      return this.prisma.connection.update({ where: { id: p.connectionId }, data: common });
    }
    return this.prisma.connection.create({
      data: {
        workspaceId: p.workspaceId,
        appKey: p.app.key,
        authType: 'OAUTH2',
        name: p.name ?? (await this.defaultName(p.workspaceId, p.app, info)),
        createdById: p.userId,
        ...common,
      },
    });
  }

  // ─── internals ───────────────────────────────────────────

  private async findOrThrow(workspaceId: string, id: string): Promise<ConnectionWithCount> {
    const row = await this.prisma.connection.findFirst({ where: { id, workspaceId }, include: withCount });
    if (!row) throw ApiException.notFound('Connection');
    return row;
  }

  private validateCredentials(app: DefinedApp, raw: Record<string, unknown>): Record<string, unknown> {
    const auth = app.auth;
    if (auth.type === 'none') throw ApiException.badRequest(`${app.name} does not need an account`);
    if (auth.type === 'oauth2') throw ApiException.badRequest(`${app.name} connects via OAuth; use the sign-in flow`);
    const result = validateInput(auth.fields, raw);
    if (!result.ok) {
      throw ApiException.validation(result.issues.map((i) => ({ path: `credentials.${i.field}`.replace(/\.$/, ''), message: i.message })));
    }
    return result.value;
  }

  private async runAuthTest(app: DefinedApp, auth: Record<string, unknown>): Promise<ConnectionInfo | undefined> {
    const test = 'test' in app.auth ? app.auth.test : undefined;
    if (!test) return undefined;
    const signal = AbortSignal.timeout(API_CONNECTOR_TIMEOUT_MS);
    try {
      return (await test({ auth: auth as never, http: this.http.withSignal(signal), logger: silentConnectorLogger, signal })) ?? undefined;
    } catch (err) {
      throw connectorErrorToHttp(err, `Could not verify your ${app.name} credentials`);
    }
  }

  private async defaultName(workspaceId: string, app: DefinedApp, info?: ConnectionInfo): Promise<string> {
    if (info?.label) return String(info.label).slice(0, 100);
    const count = await this.prisma.connection.count({ where: { workspaceId, appKey: app.key } });
    return `${app.name} #${count + 1}`;
  }

  private async liveZapsUsing(workspaceId: string, connectionId: string): Promise<string[]> {
    const zaps = await this.prisma.zap.findMany({
      where: { workspaceId, status: 'ACTIVE', deletedAt: null },
      select: { name: true, publishedVersion: { select: { definition: true } } },
    });
    return zaps
      .filter((z) => {
        const def = z.publishedVersion?.definition as unknown as ZapDefinition | undefined;
        return def && [def.trigger, ...def.steps].some((s) => s.connectionId === connectionId);
      })
      .map((z) => z.name);
  }
}

