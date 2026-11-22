import { AUTH_COOKIES } from '@flowforge/shared';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, createTestApp, registerUser, resetState, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
  ctx.google.profile = {
    sub: 'google-sub-1',
    email: 'gina@example.com',
    emailVerified: true,
    name: 'Gina Google',
    picture: 'https://example.com/gina.png',
  };
});

/** Run the start step and return the state + cookie needed for the callback. */
async function start(returnTo?: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auth/google${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`,
  });
  expect(res.statusCode).toBe(302);
  const location = new URL(res.headers.location as string);
  const stateCookie = res.cookies.find((c) => c.name === AUTH_COOKIES.oauthState)!;
  expect(stateCookie).toMatchObject({ httpOnly: true, path: '/api/v1/auth/google' });
  return {
    state: location.searchParams.get('state')!,
    challenge: location.searchParams.get('code_challenge')!,
    cookie: stateCookie.value,
  };
}

const callback = (query: string, cookie?: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auth/google/callback?${query}`,
    cookies: cookie ? { [AUTH_COOKIES.oauthState]: cookie } : {},
  });

describe('Google OAuth', () => {
  it('creates a new user + workspace and signs them in (PKCE verified)', async () => {
    const { state, challenge, cookie } = await start('/w/abc/zaps');
    const res = await callback(`code=good-code&state=${state}`, cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/w/abc/zaps');

    // Verifier sent to Google matches the challenge we published.
    const verifier = ctx.google.lastCodeVerifier!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);

    const jar = new CookieJar();
    jar.store(res);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: jar.all() });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: 'gina@example.com', hasPassword: false });
    expect(me.json().workspaces).toHaveLength(1);
  });

  it('links to an existing password account with the same verified email', async () => {
    const existing = await registerUser(ctx, { email: 'gina@example.com' });
    const { state, cookie } = await start();
    const res = await callback(`code=good-code&state=${state}`, cookie);
    expect(res.statusCode).toBe(302);
    const account = await ctx.prisma.oAuthAccount.findFirstOrThrow({ where: { provider: 'google' } });
    expect(account.userId).toBe(existing.body.user.id);
    expect(await ctx.prisma.workspace.count()).toBe(1); // no second workspace
  });

  it('signs in a returning Google user without duplicating', async () => {
    for (let i = 0; i < 2; i++) {
      const { state, cookie } = await start();
      expect((await callback(`code=good-code&state=${state}`, cookie)).statusCode).toBe(302);
    }
    expect(await ctx.prisma.user.count()).toBe(1);
  });

  it('rejects a state mismatch / missing cookie (CSRF on login)', async () => {
    const { cookie } = await start();
    const mismatch = await callback('code=good-code&state=attacker', cookie);
    expect(mismatch.headers.location).toBe('http://localhost:3000/login?error=google_state');
    const noCookie = await callback('code=good-code&state=whatever');
    expect(noCookie.headers.location).toBe('http://localhost:3000/login?error=google_state');
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it('refuses unverified Google emails', async () => {
    ctx.google.profile = { ...ctx.google.profile, emailVerified: false };
    const { state, cookie } = await start();
    const res = await callback(`code=good-code&state=${state}`, cookie);
    expect(res.headers.location).toBe('http://localhost:3000/login?error=google_unverified');
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it('handles a failed code exchange', async () => {
    const { state, cookie } = await start();
    const res = await callback(`code=bad-code&state=${state}`, cookie);
    expect(res.headers.location).toBe('http://localhost:3000/login?error=google_failed');
  });

  it('does not allow open redirects via returnTo', async () => {
    const { state, cookie } = await start('//evil.example/phish');
    const res = await callback(`code=good-code&state=${state}`, cookie);
    expect(res.headers.location).toBe('http://localhost:3000/');
  });
});
