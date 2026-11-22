import { AuthError } from '@flowforge/connector-sdk';
import { DecryptionError, SecretBox } from '@flowforge/shared/node';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthorizeUrl, CredentialStore, exchangeCode, needsRefresh, pkceChallenge } from '../src';
import { OAUTH_ENV, oauthApp, testRegistry } from './fixtures';
import { prisma, resetDb, seedZap } from './helpers';

const box = new SecretBox({ 1: randomBytes(32) }, 1);

function tokenResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function createConnection(workspaceId: string, appKey: string, creds: Record<string, unknown>, store: CredentialStore, authType: 'OAUTH2' | 'API_KEY') {
  return prisma.connection.create({
    data: { workspaceId, appKey, name: 'c', authType, createdById: 'u', ...store.encrypt(workspaceId, appKey, creds) },
  });
}

describe('CredentialStore', () => {
  it('stores ciphertext only and decrypts within the workspace', async () => {
    const { workspace } = await seedZap();
    const store = new CredentialStore(prisma, box, testRegistry());
    const conn = await createConnection(workspace.id, 'acme', { apiKey: 'sk_live_123' }, store, 'API_KEY');

    const raw = await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(Buffer.from(raw.ciphertext).toString('utf8')).not.toContain('sk_live_123');
    expect(await store.getAuth(workspace.id, conn.id)).toEqual({ apiKey: 'sk_live_123' });
  });

  it('is scoped by workspace and bound to it cryptographically', async () => {
    const a = await seedZap();
    const b = await seedZap();
    const store = new CredentialStore(prisma, box, testRegistry());
    const conn = await createConnection(a.workspace.id, 'acme', { apiKey: 'secret' }, store, 'API_KEY');

    await expect(store.getAuth(b.workspace.id, conn.id)).rejects.toThrow(/not found/);
    // Even if a row were moved to another workspace, AAD makes decryption fail.
    await prisma.connection.update({ where: { id: conn.id }, data: { workspaceId: b.workspace.id } });
    await expect(store.getAuth(b.workspace.id, conn.id)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('re-encrypts with the current key after rotation', async () => {
    const { workspace } = await seedZap();
    const oldKey = randomBytes(32);
    const oldStore = new CredentialStore(prisma, new SecretBox({ 1: oldKey }, 1), testRegistry());
    const conn = await createConnection(workspace.id, 'acme', { apiKey: 'k' }, oldStore, 'API_KEY');

    const rotated = new CredentialStore(prisma, new SecretBox({ 1: oldKey, 2: randomBytes(32) }, 2), testRegistry());
    expect(await rotated.getAuth(workspace.id, conn.id)).toEqual({ apiKey: 'k' });
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } })).keyVersion).toBe(2);
  });

  describe('OAuth2 refresh', () => {
    const expiring = () => ({ accessToken: 'old', refreshToken: 'r1', expiresAt: new Date(Date.now() + 30_000).toISOString() });

    it('refreshes expiring tokens once, even under concurrency', async () => {
      const { workspace } = await seedZap();
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        await new Promise((r) => setTimeout(r, 50));
        const params = new URLSearchParams(String(init!.body));
        expect(Object.fromEntries(params)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid', client_secret: 'csecret' });
        return tokenResponse({ access_token: 'new', expires_in: 3600, token_type: 'Bearer' });
      });
      const store = new CredentialStore(prisma, box, testRegistry(), { env: OAUTH_ENV, fetchImpl });
      const conn = await createConnection(workspace.id, 'oauthy', expiring(), store, 'OAUTH2');

      const results = await Promise.all([1, 2, 3].map(() => store.getAuth(workspace.id, conn.id)));
      expect(results.map((r) => r.accessToken)).toEqual(['new', 'new', 'new']);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const stored = store.decrypt<{ refreshToken: string; expiresAt: string }>(await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } }));
      expect(stored.refreshToken).toBe('r1'); // kept when the provider omits it
      expect(needsRefresh(stored as never)).toBe(false);
    });

    it('marks the connection EXPIRED on invalid_grant', async () => {
      const { workspace } = await seedZap();
      const fetchImpl = vi.fn(async () => tokenResponse({ error: 'invalid_grant', error_description: 'revoked' }, 400));
      const store = new CredentialStore(prisma, box, testRegistry(), { env: OAUTH_ENV, fetchImpl });
      const conn = await createConnection(workspace.id, 'oauthy', expiring(), store, 'OAUTH2');

      await expect(store.getAuth(workspace.id, conn.id)).rejects.toBeInstanceOf(AuthError);
      const row = await prisma.connection.findUniqueOrThrow({ where: { id: conn.id } });
      expect(row.status).toBe('EXPIRED');
      expect(row.lastError).toMatch(/revoked/);
    });

    it('does not refresh valid tokens', async () => {
      const { workspace } = await seedZap();
      const fetchImpl = vi.fn();
      const store = new CredentialStore(prisma, box, testRegistry(), { env: OAUTH_ENV, fetchImpl });
      const conn = await createConnection(workspace.id, 'oauthy', { accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, store, 'OAUTH2');
      expect((await store.getAuth(workspace.id, conn.id)).accessToken).toBe('a');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe('OAuth2 helpers', () => {
  const auth = oauthApp.auth as Extract<typeof oauthApp.auth, { type: 'oauth2' }>;

  it('builds an authorize URL with PKCE and extra params', () => {
    const url = new URL(buildAuthorizeUrl(auth, { clientId: 'cid', redirectUri: 'https://app/cb', state: 's1', codeVerifier: 'v'.repeat(43) }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://app/cb',
      state: 's1',
      scope: 'read write',
      access_type: 'offline',
      code_challenge: pkceChallenge('v'.repeat(43)),
      code_challenge_method: 'S256',
    });
  });

  it('exchanges a code (JSON or form-encoded responses)', async () => {
    const json = await exchangeCode(auth, { code: 'c', redirectUri: 'r', clientId: 'i', clientSecret: 's', codeVerifier: 'v' }, async (_u, init) => {
      expect(String(init!.body)).toContain('code_verifier=v');
      return tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 60, scope: 'read' });
    });
    expect(json).toMatchObject({ accessToken: 'at', refreshToken: 'rt', scope: 'read', tokenType: 'Bearer' });

    const form = await exchangeCode(auth, { code: 'c', redirectUri: 'r', clientId: 'i', clientSecret: 's' }, async () =>
      new Response('access_token=at2&token_type=bearer', { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    );
    expect(form.accessToken).toBe('at2');
  });
});
