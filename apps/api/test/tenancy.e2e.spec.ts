import { API_KEY_PREFIX } from '@flowforge/shared';
import { randomToken, sha256Hex } from '@flowforge/shared/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, resetState, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

async function createApiKey(workspaceId: string, createdById: string, extra: object = {}) {
  const raw = `${API_KEY_PREFIX}${randomToken(24)}`;
  await ctx.prisma.apiKey.create({
    data: {
      workspaceId,
      createdById,
      name: 'test',
      prefix: raw.slice(0, 12),
      keyHash: sha256Hex(raw),
      ...extra,
    },
  });
  return raw;
}

describe('workspace isolation', () => {
  it('members can read their workspace; others get 404', async () => {
    const alice = await registerUser(ctx, { email: 'alice@example.com' });
    const bob = await registerUser(ctx, { email: 'bob@example.com' });
    const aliceWs = alice.body.workspaces[0]!.id;

    const own = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${aliceWs}`,
      cookies: alice.jar.all(),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: aliceWs, role: 'OWNER' });

    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${aliceWs}`,
      cookies: bob.jar.all(),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('lists only the caller’s workspaces', async () => {
    const alice = await registerUser(ctx, { email: 'alice@example.com' });
    await registerUser(ctx, { email: 'bob@example.com' });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/workspaces', cookies: alice.jar.all() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

describe('API key authentication', () => {
  it('authenticates on workspace routes and is bound to its workspace', async () => {
    const alice = await registerUser(ctx, { email: 'alice@example.com' });
    const bob = await registerUser(ctx, { email: 'bob@example.com' });
    const aliceWs = alice.body.workspaces[0]!.id;
    const bobWs = bob.body.workspaces[0]!.id;
    const key = await createApiKey(aliceWs, alice.body.user.id);

    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${aliceWs}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(ok.statusCode).toBe(200);

    const cross = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${bobWs}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(cross.statusCode).toBe(404);
  });

  it('cannot call user-only endpoints', async () => {
    const alice = await registerUser(ctx, { email: 'alice@example.com' });
    const key = await createApiKey(alice.body.workspaces[0]!.id, alice.body.user.id);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unknown, revoked and expired keys', async () => {
    const alice = await registerUser(ctx, { email: 'alice@example.com' });
    const ws = alice.body.workspaces[0]!.id;
    const revoked = await createApiKey(ws, alice.body.user.id, { revokedAt: new Date() });
    const expired = await createApiKey(ws, alice.body.user.id, { expiresAt: new Date(Date.now() - 1000) });
    for (const key of [`${API_KEY_PREFIX}${randomToken(24)}`, revoked, expired]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${ws}`,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('stops working when its creator leaves the workspace', async () => {
    const alice = await registerUser(ctx, { email: 'alice@example.com' });
    const ws = alice.body.workspaces[0]!.id;
    const key = await createApiKey(ws, alice.body.user.id);
    await ctx.prisma.membership.deleteMany({ where: { workspaceId: ws, userId: alice.body.user.id } });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ws}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records lastUsedAt', async () => {
    const alice = await registerUser(ctx, { email: 'alice@example.com' });
    const ws = alice.body.workspaces[0]!.id;
    const key = await createApiKey(ws, alice.body.user.id);
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ws}`,
      headers: { authorization: `Bearer ${key}` },
    });
    await new Promise((r) => setTimeout(r, 100));
    const row = await ctx.prisma.apiKey.findUniqueOrThrow({ where: { keyHash: sha256Hex(key) } });
    expect(row.lastUsedAt).not.toBeNull();
  });
});
