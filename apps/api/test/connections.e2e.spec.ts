import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { oauthCalls } from './fixtures';
import { createTestApp, resetState, signUp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
  oauthCalls.length = 0;
});

describe('API-key connections', () => {
  it('validates, tests, encrypts and never returns secrets', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const res = await alice.api.post(`/workspaces/${alice.ws}/connections`, {
      appKey: 'acme',
      credentials: { apiKey: 'sk_live_supersecret', account: 'eu' },
    });
    expect(res.statusCode).toBe(201);
    const conn = res.json();
    expect(conn).toMatchObject({ appKey: 'acme', name: 'Acme (eu)', authType: 'API_KEY', status: 'ACTIVE', displayInfo: { label: 'Acme (eu)' }, usedBySteps: 0 });
    expect(JSON.stringify(conn)).not.toContain('supersecret');

    const row = await ctx.prisma.connection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(Buffer.from(row.ciphertext).toString()).not.toContain('supersecret');
    expect(row.iv).toHaveLength(12);
    expect(row.authTag).toHaveLength(16);

    const list = (await alice.api.get(`/workspaces/${alice.ws}/connections?appKey=acme`)).json();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('supersecret');
  });

  it('rejects invalid and failing credentials', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const invalid = await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'x', extra: 1 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.issues.map((i: { path: string }) => i.path).sort()).toEqual(['credentials.apiKey', 'credentials.extra']);

    const bad = await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'bad-key' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/API key rejected/);

    const down = await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'down-key' } });
    expect(down.statusCode).toBe(502);
    expect(down.json().error.code).toBe('UPSTREAM_ERROR');

    expect((await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'oauthy', credentials: {} })).statusCode).toBe(400);
    expect((await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'webhook', credentials: {} })).statusCode).toBe(400);
    expect(await ctx.prisma.connection.count()).toBe(0);
  });

  it('updates credentials, re-tests, and is tenant-isolated', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const bob = await signUp(ctx, 'bob@example.com');
    const conn = (await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'acme', name: 'Prod', credentials: { apiKey: 'key1' } })).json();
    expect(conn.name).toBe('Prod');

    const updated = await alice.api.patch(`/workspaces/${alice.ws}/connections/${conn.id}`, { credentials: { apiKey: 'key2', account: 'us' } });
    expect(updated.json().displayInfo.label).toBe('Acme (us)');
    expect((await alice.api.post(`/workspaces/${alice.ws}/connections/${conn.id}/test`)).json().status).toBe('ACTIVE');

    // Bob can't see or use Alice's connection, even with her id.
    expect((await bob.api.get(`/workspaces/${alice.ws}/connections/${conn.id}`)).statusCode).toBe(404);
    expect((await bob.api.get(`/workspaces/${bob.ws}/connections/${conn.id}`)).statusCode).toBe(404);
    const zap = (await bob.api.post(`/workspaces/${bob.ws}/zaps`, { name: 'steal' })).json();
    const steal = await bob.api.post(`/workspaces/${bob.ws}/zaps/${zap.id}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id });
    expect(steal.statusCode).toBe(400);
  });

  it('loads dynamic options with the connection', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const conn = (await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'key1', account: 'eu' } })).json();
    const res = await alice.api.post(`/workspaces/${alice.ws}/apps/acme/options`, { loader: 'lists', connectionId: conn.id, config: { filter: 'vip' } });
    expect(res.json()).toEqual([
      { label: 'Main list for eu', value: 'main' },
      { label: 'Filtered by vip', value: 'filtered' },
    ]);
    expect((await alice.api.post(`/workspaces/${alice.ws}/apps/acme/options`, { loader: 'lists' })).statusCode).toBe(400);
    expect((await alice.api.post(`/workspaces/${alice.ws}/apps/acme/options`, { loader: 'nope', connectionId: conn.id })).statusCode).toBe(404);
  });

  it('refuses to delete a connection used by an active zap', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const conn = (await alice.api.post(`/workspaces/${alice.ws}/connections`, { appKey: 'acme', credentials: { apiKey: 'key1' } })).json();
    const zap = (await alice.api.post(`/workspaces/${alice.ws}/zaps`, { name: 'Uses acme' })).json();
    await alice.api.put(`/workspaces/${alice.ws}/zaps/${zap.id}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
    await alice.api.post(`/workspaces/${alice.ws}/zaps/${zap.id}/steps`, { appKey: 'acme', operationKey: 'createContact', connectionId: conn.id, config: { email: '{{ trigger.body.email }}' } });
    expect((await alice.api.post(`/workspaces/${alice.ws}/zaps/${zap.id}/enable`)).statusCode).toBe(200);

    const blocked = await alice.api.del(`/workspaces/${alice.ws}/connections/${conn.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/Uses acme/);

    await alice.api.post(`/workspaces/${alice.ws}/zaps/${zap.id}/disable`);
    expect((await alice.api.del(`/workspaces/${alice.ws}/connections/${conn.id}`)).statusCode).toBe(204);
    // Draft step loses its connection (FK SET NULL) instead of dangling.
    expect((await alice.api.get(`/workspaces/${alice.ws}/zaps/${zap.id}`)).json().steps[1].connectionId).toBeNull();
  });
});

describe('OAuth2 connections', () => {
  async function startFlow(api: Awaited<ReturnType<typeof signUp>>['api'], ws: string, query = '') {
    const res = await api.get(`/workspaces/${ws}/connections/oauth/oauthy/start${query}`);
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://auth.oauthy.test/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/v1/connections/oauth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('read write');
    return url.searchParams.get('state')!;
  }

  it('completes the flow, stores encrypted tokens and supports reconnect', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const state = await startFlow(alice.api, alice.ws, '?name=Team%20OAuthy');
    const cb = await alice.api.get(`/connections/oauth/callback?state=${state}&code=good`);
    expect(cb.statusCode).toBe(302);
    const loc = new URL(cb.headers.location as string);
    expect(loc.pathname).toBe(`/w/${alice.ws}/connections`);
    const connId = loc.searchParams.get('connected')!;

    expect(oauthCalls[0]).toMatchObject({ grant_type: 'authorization_code', code: 'good', client_id: 'oauthy-client', client_secret: 'oauthy-secret' });
    expect(oauthCalls[0]!.code_verifier).toBeTruthy();

    const conn = (await alice.api.get(`/workspaces/${alice.ws}/connections/${connId}`)).json();
    expect(conn).toMatchObject({ name: 'Team OAuthy', authType: 'OAUTH2', status: 'ACTIVE', scopes: ['read', 'write'], displayInfo: { label: 'oauthy:at_goo' } });
    expect(conn.expiresAt).toBeTruthy();

    // State is single-use.
    const replay = await alice.api.get(`/connections/oauth/callback?state=${state}&code=good`);
    expect(new URL(replay.headers.location as string).searchParams.get('oauth_error')).toMatch(/expired/);

    // Reconnect updates the same connection.
    const state2 = await startFlow(alice.api, alice.ws, `?connectionId=${connId}`);
    const cb2 = await alice.api.get(`/connections/oauth/callback?state=${state2}&code=second`);
    expect(new URL(cb2.headers.location as string).searchParams.get('connected')).toBe(connId);
    expect(await ctx.prisma.connection.count()).toBe(1);
  });

  it('binds the flow to the user who started it', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const mallory = await signUp(ctx, 'mallory@example.com');
    const state = await startFlow(alice.api, alice.ws);
    const res = await mallory.api.get(`/connections/oauth/callback?state=${state}&code=good`);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toMatch(/different user/);
    expect(await ctx.prisma.connection.count()).toBe(0);
  });

  it('handles provider errors and denied consent', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const s1 = await startFlow(alice.api, alice.ws);
    const denied = await alice.api.get(`/connections/oauth/callback?state=${s1}&error=access_denied`);
    expect(new URL(denied.headers.location as string).searchParams.get('error')).toBe('Access was denied');
    const s2 = await startFlow(alice.api, alice.ws);
    const bad = await alice.api.get(`/connections/oauth/callback?state=${s2}&code=bad-code`);
    expect(new URL(bad.headers.location as string).searchParams.get('error')).toMatch(/no longer valid/);
  });
});
