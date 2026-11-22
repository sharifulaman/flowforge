import { PrismaClient } from '@flowforge/db';
import { Redis } from 'ioredis';

export const prisma = new PrismaClient();

export function redisConnection() {
  return new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
}

export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} CASCADE`);
  }
}

/** A user + workspace + zap with a published version, ready for runs. */
export async function seedZap() {
  const user = await prisma.user.create({ data: { email: `u${Date.now()}${Math.random()}@x.test` } });
  const workspace = await prisma.workspace.create({ data: { name: 'W', slug: `w-${Math.random().toString(36).slice(2)}` } });
  await prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: 'OWNER' } });
  const zap = await prisma.zap.create({ data: { workspaceId: workspace.id, name: 'Z', createdById: user.id } });
  const version = await prisma.zapVersion.create({
    data: {
      zapId: zap.id,
      workspaceId: workspace.id,
      version: 1,
      createdById: user.id,
      definition: { schemaVersion: 1, trigger: {}, steps: [] },
    },
  });
  return { user, workspace, zap, version };
}
