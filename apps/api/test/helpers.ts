import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@flowforge/db';
import { Redis } from 'ioredis';
import { configureApp, createAdapter, createApiLogger } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { loadApiEnv } from '../src/config/env';
import { GoogleOAuthClient, type GoogleProfile } from '../src/modules/auth/google-oauth.client';

export const ORIGIN = 'http://localhost:3000';

export class FakeGoogleClient extends GoogleOAuthClient {
  profile: GoogleProfile = {
    sub: 'google-sub-1',
    email: 'gina@example.com',
    emailVerified: true,
    name: 'Gina Google',
    picture: 'https://example.com/gina.png',
  };
  lastCodeVerifier?: string;

  isConfigured() {
    return true;
  }
  buildAuthUrl({ state, codeChallenge }: { state: string; codeChallenge: string }) {
    return `https://accounts.google.test/auth?state=${state}&code_challenge=${codeChallenge}`;
  }
  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier: string }) {
    if (code !== 'good-code') throw new Error('bad code');
    this.lastCodeVerifier = codeVerifier;
    return this.profile;
  }
}

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaClient;
  redis: Redis;
  google: FakeGoogleClient;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const env = loadApiEnv();
  const google = new FakeGoogleClient();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(GoogleOAuthClient)
    .useValue(google)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(env, createApiLogger(env)), {
    logger: false,
  });
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const prisma = new PrismaClient();
  const redis = new Redis(env.REDIS_URL);
  return {
    app,
    prisma,
    redis,
    google,
    async close() {
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}

/** Wipe all tables and the test Redis DB between tests. */
export async function resetState(ctx: TestContext): Promise<void> {
  const tables = await ctx.prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await ctx.prisma.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
  await ctx.redis.flushdb();
}

/** Minimal cookie jar over light-my-request responses. */
export class CookieJar {
  private jar = new Map<string, string>();

  store(res: { cookies: Array<{ name: string; value: string; maxAge?: number; expires?: Date }> }): void {
    for (const c of res.cookies) {
      const expired = c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now()) || c.value === '';
      if (expired) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
  }
  get(name: string): string | undefined {
    return this.jar.get(name);
  }
  set(name: string, value: string): void {
    this.jar.set(name, value);
  }
  all(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }
}

export async function registerUser(
  ctx: TestContext,
  data: { email: string; password?: string; name?: string },
): Promise<{ jar: CookieJar; body: { user: { id: string }; workspaces: Array<{ id: string; role: string }> } }> {
  const jar = new CookieJar();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin: ORIGIN },
    payload: { email: data.email, password: data.password ?? 'password123', name: data.name ?? 'Test User' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  jar.store(res);
  return { jar, body: res.json() };
}
