import { AuthError, type ConnectorRegistry, type OAuth2Credentials } from '@flowforge/connector-sdk';
import type { Connection, PrismaClient } from '@flowforge/db';
import type { EncryptedPayload, SecretBox } from '@flowforge/shared/node';
import { type FetchLike, needsRefresh, oauthClientCredentials, refreshAccessToken } from './oauth2';

export class ConnectionNotFoundError extends Error {
  constructor(id: string) {
    super(`Connection ${id} not found`);
    this.name = 'ConnectionNotFoundError';
  }
}

export interface CredentialStoreOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * Encrypted credential storage. Secrets are AES-256-GCM encrypted with AAD
 * `<workspaceId>:<appKey>` so a ciphertext can't be moved to another workspace or app.
 * Plaintext only ever exists in memory for the duration of a call.
 */
export class CredentialStore {
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly box: SecretBox,
    private readonly registry: ConnectorRegistry,
    opts: CredentialStoreOptions = {},
  ) {
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static aad(workspaceId: string, appKey: string): string {
    return `${workspaceId}:${appKey}`;
  }

  encrypt(workspaceId: string, appKey: string, credentials: Record<string, unknown>) {
    const enc = this.box.encryptJson(credentials, CredentialStore.aad(workspaceId, appKey));
    // Prisma's Bytes type is Uint8Array<ArrayBuffer>; copy out of Node's pooled Buffers.
    const bytes = (b: Buffer) => new Uint8Array(b);
    return { ciphertext: bytes(enc.ciphertext), iv: bytes(enc.iv), authTag: bytes(enc.authTag), keyVersion: enc.keyVersion };
  }

  decrypt<T = Record<string, unknown>>(conn: Pick<Connection, 'workspaceId' | 'appKey' | 'ciphertext' | 'iv' | 'authTag' | 'keyVersion'>): T {
    const payload: EncryptedPayload = {
      ciphertext: Buffer.from(conn.ciphertext),
      iv: Buffer.from(conn.iv),
      authTag: Buffer.from(conn.authTag),
      keyVersion: conn.keyVersion,
    };
    return this.box.decryptJson<T>(payload, CredentialStore.aad(conn.workspaceId, conn.appKey));
  }

  /**
   * Decrypted credentials for a connection, refreshing OAuth tokens when needed.
   * Always scoped by workspace.
   */
  async getAuth(workspaceId: string, connectionId: string, opts: { forceRefresh?: boolean } = {}): Promise<Record<string, any>> {
    const conn = await this.prisma.connection.findFirst({ where: { id: connectionId, workspaceId } });
    if (!conn) throw new ConnectionNotFoundError(connectionId);

    let creds = this.decrypt<Record<string, any>>(conn);
    if (conn.authType === 'OAUTH2' && (opts.forceRefresh || needsRefresh(creds as OAuth2Credentials))) {
      creds = await this.refreshLocked(conn.id, workspaceId, opts.forceRefresh ?? false);
    } else if (this.box.needsRotation(conn)) {
      // Opportunistic re-encryption with the current key.
      await this.prisma.connection.update({ where: { id: conn.id }, data: this.encrypt(workspaceId, conn.appKey, creds) });
    }
    this.touch(conn);
    return creds;
  }

  /** Persist new credentials (e.g. after reconnect). */
  async save(conn: Pick<Connection, 'id' | 'workspaceId' | 'appKey'>, creds: Record<string, unknown>, expiresAt?: Date | null) {
    await this.prisma.connection.update({
      where: { id: conn.id },
      data: { ...this.encrypt(conn.workspaceId, conn.appKey, creds), expiresAt: expiresAt ?? null, status: 'ACTIVE', lastError: null },
    });
  }

  async markError(connectionId: string, message: string, status: 'ERROR' | 'EXPIRED' = 'ERROR'): Promise<void> {
    await this.prisma.connection.update({ where: { id: connectionId }, data: { status, lastError: message.slice(0, 500) } });
  }

  /**
   * Refresh under a row lock so concurrent workers don't race (providers that rotate
   * refresh tokens would otherwise invalidate each other's tokens).
   */
  private async refreshLocked(connectionId: string, workspaceId: string, force: boolean): Promise<Record<string, any>> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Connection" WHERE id = ${connectionId} FOR UPDATE`;
        const conn = await tx.connection.findFirstOrThrow({ where: { id: connectionId, workspaceId } });
        const current = this.decrypt<OAuth2Credentials>(conn);
        if (!force && !needsRefresh(current)) return current as unknown as Record<string, any>; // someone else refreshed

        const app = this.registry.get(conn.appKey);
        if (!app || app.auth.type !== 'oauth2') throw new AuthError(`App ${conn.appKey} does not support OAuth`);
        const client = oauthClientCredentials(app.auth, this.env);
        if (!client) throw new AuthError(`OAuth client credentials for ${app.name} are not configured on the server`);

        const next = await refreshAccessToken(app.auth, current, client, this.fetchImpl);
        await tx.connection.update({
          where: { id: conn.id },
          data: {
            ...this.encrypt(workspaceId, conn.appKey, next as unknown as Record<string, unknown>),
            expiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
            status: 'ACTIVE',
            lastError: null,
          },
        });
        return next as unknown as Record<string, any>;
      },
      { timeout: 30_000, maxWait: 10_000 },
    ).catch(async (err: unknown) => {
      // Outside the (rolled-back) transaction so the status change sticks.
      if (err instanceof AuthError) await this.markError(connectionId, err.message, 'EXPIRED').catch(() => undefined);
      throw err;
    });
  }

  private touch(conn: Pick<Connection, 'id' | 'lastUsedAt'>): void {
    if (conn.lastUsedAt && Date.now() - conn.lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS) return;
    void this.prisma.connection.update({ where: { id: conn.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
}
