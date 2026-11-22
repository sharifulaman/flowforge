import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ORIGIN, registerUser, resetState, type TestContext } from './helpers';

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

describe('CSRF origin check', () => {
  it('blocks cookie-authenticated mutations from a foreign origin', async () => {
    const { jar } = await registerUser(ctx, { email: 'csrf@example.com' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: 'https://evil.example' },
      cookies: jar.all(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_REJECTED');
  });

  it('blocks cookie-authenticated mutations with no Origin/Referer', async () => {
    const { jar } = await registerUser(ctx, { email: 'csrf2@example.com' });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies: jar.all() });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a matching Referer when Origin is absent', async () => {
    const { jar } = await registerUser(ctx, { email: 'csrf3@example.com' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { referer: `${ORIGIN}/settings` },
      cookies: jar.all(),
    });
    expect(res.statusCode).toBe(204);
  });

  it('allows safe methods cross-origin and cookie-less requests', async () => {
    const { jar } = await registerUser(ctx, { email: 'csrf4@example.com' });
    const get = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { origin: 'https://evil.example' },
      cookies: jar.all(),
    });
    expect(get.statusCode).toBe(200);
    const noCookie = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'x@example.com', password: 'whatever1' },
    });
    expect(noCookie.statusCode).toBe(401); // reached the handler, not CSRF-blocked
  });
});

describe('rate limiting', () => {
  it('limits login attempts to 10/min per IP (Redis-backed)', async () => {
    const attempt = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: 'brute@example.com', password: 'guess-guess' },
        remoteAddress: '10.1.2.3',
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');

    // A different IP is unaffected.
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'brute@example.com', password: 'guess-guess' },
      remoteAddress: '10.9.9.9',
    });
    expect(other.statusCode).toBe(401);
    const keys = await ctx.redis.keys('ff:throttle:*');
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('request hygiene', () => {
  it('echoes a valid x-request-id and generates one otherwise', async () => {
    const withId = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'client-req-12345' },
    });
    expect(withId.headers['x-request-id']).toBe('client-req-12345');
    const bogus = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    expect(bogus.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('rejects oversized bodies', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('readiness reports dependencies', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toMatchObject({ postgres: { ok: true }, redis: { ok: true } });
  });
});
