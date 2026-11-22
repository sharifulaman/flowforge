import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
});

describe('workspaces', () => {
  it('creates, renames and deletes workspaces with role checks', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const created = await alice.api.post('/workspaces', { name: 'Marketing Ops' });
    expect(created.statusCode).toBe(201);
    const ws = created.json();
    expect(ws).toMatchObject({ name: 'Marketing Ops', role: 'OWNER' });
    expect(ws.slug).toMatch(/^marketing-ops-[0-9a-f]{6}$/);

    expect((await alice.api.patch(`/workspaces/${ws.id}`, { name: 'Growth' })).json().name).toBe('Growth');
    expect((await alice.api.get('/workspaces')).json()).toHaveLength(2);

    expect((await alice.api.del(`/workspaces/${ws.id}`)).statusCode).toBe(204);
    expect((await alice.api.get(`/workspaces/${ws.id}`)).statusCode).toBe(404);
  });

  it('validates input', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const res = await alice.api.post('/workspaces', { name: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.issues[0].path).toBe('name');
  });
});

describe('members', () => {
  it('adds existing users, enforces roles and protects the last owner', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const bob = await signUp(ctx, 'bob@example.com');
    const carol = await signUp(ctx, 'carol@example.com');

    // Unknown email
    expect((await alice.api.post(`/workspaces/${alice.ws}/members`, { email: 'ghost@example.com' })).statusCode).toBe(404);

    const added = await alice.api.post(`/workspaces/${alice.ws}/members`, { email: 'BOB@example.com' });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ email: 'bob@example.com', role: 'MEMBER' });
    expect((await alice.api.post(`/workspaces/${alice.ws}/members`, { email: 'bob@example.com' })).statusCode).toBe(409);

    // Bob (MEMBER) can see the workspace but not manage members.
    expect((await bob.api.get(`/workspaces/${alice.ws}`)).json().role).toBe('MEMBER');
    expect((await bob.api.post(`/workspaces/${alice.ws}/members`, { email: 'carol@example.com' })).statusCode).toBe(403);
    expect((await bob.api.patch(`/workspaces/${alice.ws}`, { name: 'x' })).statusCode).toBe(403);

    // Promote Bob to ADMIN; admins cannot mint owners.
    const memberId = added.json().id;
    expect((await alice.api.patch(`/workspaces/${alice.ws}/members/${memberId}`, { role: 'ADMIN' })).json().role).toBe('ADMIN');
    expect((await bob.api.post(`/workspaces/${alice.ws}/members`, { email: 'carol@example.com', role: 'OWNER' })).statusCode).toBe(403);
    expect((await bob.api.post(`/workspaces/${alice.ws}/members`, { email: 'carol@example.com' })).statusCode).toBe(201);

    // The only owner can't leave or be demoted.
    const members = (await alice.api.get(`/workspaces/${alice.ws}/members`)).json();
    expect(members).toHaveLength(3);
    const aliceMember = members.find((m: { email: string }) => m.email === 'alice@example.com');
    expect((await alice.api.del(`/workspaces/${alice.ws}/members/${aliceMember.id}`)).statusCode).toBe(409);
    expect((await alice.api.patch(`/workspaces/${alice.ws}/members/${aliceMember.id}`, { role: 'ADMIN' })).statusCode).toBe(409);

    // Members can leave on their own.
    const carolMember = members.find((m: { email: string }) => m.email === 'carol@example.com');
    expect((await carol.api.del(`/workspaces/${alice.ws}/members/${carolMember.id}`)).statusCode).toBe(204);
    expect((await carol.api.get(`/workspaces/${alice.ws}`)).statusCode).toBe(404);

    // Only owners delete workspaces.
    expect((await bob.api.del(`/workspaces/${alice.ws}`)).statusCode).toBe(403);
  });
});

describe('API keys', () => {
  it('creates a key shown once, authenticates with it, and revokes it', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const created = await alice.api.post(`/workspaces/${alice.ws}/api-keys`, { name: 'CI', expiresInDays: 30 });
    expect(created.statusCode).toBe(201);
    const { key, id, prefix } = created.json();
    expect(key).toMatch(/^ff_live_[A-Za-z0-9_-]{40,}$/);
    expect(key.startsWith(prefix)).toBe(true);

    const listed = (await alice.api.get(`/workspaces/${alice.ws}/api-keys`)).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(key);

    const withKey = (url: string) => ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${key}` } });
    expect((await withKey(`/workspaces/${alice.ws}/zaps`)).statusCode).toBe(200);
    // Keys can't manage keys.
    expect((await withKey(`/workspaces/${alice.ws}/api-keys`)).statusCode).toBe(403);

    expect((await alice.api.del(`/workspaces/${alice.ws}/api-keys/${id}`)).statusCode).toBe(204);
    expect((await withKey(`/workspaces/${alice.ws}/zaps`)).statusCode).toBe(401);
    expect((await alice.api.del(`/workspaces/${alice.ws}/api-keys/nope`)).statusCode).toBe(404);
  });

  it('is restricted to admins', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const bob = await signUp(ctx, 'bob@example.com');
    await alice.api.post(`/workspaces/${alice.ws}/members`, { email: 'bob@example.com' });
    expect((await bob.api.post(`/workspaces/${alice.ws}/api-keys`, { name: 'x' })).statusCode).toBe(403);
  });
});

describe('app registry', () => {
  it('serves function-free manifests with JSON schemas', async () => {
    const alice = await signUp(ctx, 'alice@example.com');
    const apps = (await alice.api.get('/apps')).json();
    expect(apps.map((a: { key: string }) => a.key)).toEqual(expect.arrayContaining(['webhook', 'schedule', 'acme', 'oauthy']));
    expect(apps[0].category).toBe('core');
    const acme = (await alice.api.get('/apps/acme')).json();
    expect(acme.auth).toMatchObject({ type: 'api_key', available: true });
    expect(acme.actions[0].input.properties.email.format).toBe('email');
    expect((await alice.api.get('/apps/nope')).statusCode).toBe(404);
  });
});
