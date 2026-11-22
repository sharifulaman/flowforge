import { AUTH_COOKIES } from '@flowforge/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_REUSE_GRACE_MS } from '../src/modules/auth/tokens.service';
import { CookieJar, createTestApp, ORIGIN, registerUser, resetState, type TestContext } from './helpers';

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

const me = (jar: CookieJar) =>
  ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: jar.all() });

const refresh = (jar: CookieJar) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { origin: ORIGIN }, cookies: jar.all() });

describe('POST /auth/register', () => {
  it('creates the user, a personal workspace, and sets auth cookies', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: ORIGIN },
      payload: { email: 'Ada@Example.com', password: 'password123', name: 'Ada Lovelace' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada Lovelace', hasPassword: true });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({ name: "Ada's Workspace", role: 'OWNER' });

    const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c]));
    expect(cookies[AUTH_COOKIES.access]).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookies[AUTH_COOKIES.refresh]).toMatchObject({ httpOnly: true, path: '/api/v1/auth' });
    expect(cookies[AUTH_COOKIES.session]).toBeDefined();

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.com' } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects duplicate emails with 409', async () => {
    await registerUser(ctx, { email: 'dup@example.com' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: ORIGIN },
      payload: { email: 'DUP@example.com', password: 'password123', name: 'Dup' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('returns field-level validation issues', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: ORIGIN },
      payload: { email: 'not-an-email', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.issues.map((i: { path: string }) => i.path).sort()).toEqual(['email', 'name', 'password']);
    expect(error.requestId).toBeTruthy();
  });
});

describe('POST /auth/login', () => {
  it('logs in with correct credentials', async () => {
    await registerUser(ctx, { email: 'bob@example.com', password: 'correct-horse' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'bob@example.com', password: 'correct-horse' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('bob@example.com');
    const jar = new CookieJar();
    jar.store(res);
    expect((await me(jar)).statusCode).toBe(200);
  });

  it('uses the same error for wrong password and unknown user', async () => {
    await registerUser(ctx, { email: 'bob@example.com', password: 'correct-horse' });
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'bob@example.com', password: 'nope-nope' },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'ghost@example.com', password: 'nope-nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });
});

describe('GET /auth/me', () => {
  it('requires authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged access token', async () => {
    const { jar } = await registerUser(ctx, { email: 'eve@example.com' });
    const [h, p] = jar.get(AUTH_COOKIES.access)!.split('.');
    jar.set(AUTH_COOKIES.access, `${h}.${p}.invalidsignature`);
    expect((await me(jar)).statusCode).toBe(401);
  });
});

describe('refresh-token rotation', () => {
  it('rotates the refresh token and keeps the user signed in', async () => {
    const { jar } = await registerUser(ctx, { email: 'rot@example.com' });
    const before = jar.get(AUTH_COOKIES.refresh);
    const res = await refresh(jar);
    expect(res.statusCode).toBe(200);
    jar.store(res);
    expect(jar.get(AUTH_COOKIES.refresh)).not.toBe(before);
    expect((await me(jar)).statusCode).toBe(200);
  });

  it('a stale token within the grace window is rejected without killing the family', async () => {
    const { jar } = await registerUser(ctx, { email: 'race@example.com' });
    const stale = new CookieJar();
    stale.set(AUTH_COOKIES.refresh, jar.get(AUTH_COOKIES.refresh)!);

    const first = await refresh(jar);
    jar.store(first);
    expect(first.statusCode).toBe(200);

    const second = await refresh(stale); // e.g. a second tab racing
    expect(second.statusCode).toBe(401);
    expect((await me(jar)).statusCode).toBe(200); // winner's session still alive
  });

  it('detects reuse after the grace window and revokes the whole family', async () => {
    const { jar } = await registerUser(ctx, { email: 'theft@example.com' });
    const stolen = jar.get(AUTH_COOKIES.refresh)!;

    const rotated = await refresh(jar);
    jar.store(rotated);

    // Age the revocation past the grace window.
    await ctx.prisma.session.updateMany({
      where: { revokedAt: { not: null } },
      data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1_000) },
    });

    const attacker = new CookieJar();
    attacker.set(AUTH_COOKIES.refresh, stolen);
    expect((await refresh(attacker)).statusCode).toBe(401);

    // Legitimate user's current session was revoked too.
    expect((await me(jar)).statusCode).toBe(401);
    expect((await refresh(jar)).statusCode).toBe(401);
    const active = await ctx.prisma.session.count({ where: { revokedAt: null } });
    expect(active).toBe(0);
  });

  it('clears cookies when refresh fails', async () => {
    const jar = new CookieJar();
    jar.set(AUTH_COOKIES.refresh, 'garbage');
    const res = await refresh(jar);
    expect(res.statusCode).toBe(401);
    const cleared = res.cookies.find((c) => c.name === AUTH_COOKIES.refresh);
    expect(cleared?.value).toBe('');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session server-side immediately', async () => {
    const { jar } = await registerUser(ctx, { email: 'out@example.com' });
    const stolenAccess = jar.get(AUTH_COOKIES.access)!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ORIGIN },
      cookies: jar.all(),
    });
    expect(res.statusCode).toBe(204);

    // Even though the JWT hasn't expired, it no longer works.
    const replay = new CookieJar();
    replay.set(AUTH_COOKIES.access, stolenAccess);
    expect((await me(replay)).statusCode).toBe(401);
    expect((await refresh(jar)).statusCode).toBe(401);
  });
});
