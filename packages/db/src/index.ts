import { PrismaClient } from '../generated/client';

export * from '../generated/client';

const globalForPrisma = globalThis as unknown as { __flowforgePrisma?: PrismaClient };

/**
 * Create a new PrismaClient. Prefer `getPrisma()` for the process-wide singleton;
 * use this only when you need an isolated client (e.g. tests with a different URL).
 */
export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
    log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

/** Process-wide PrismaClient singleton (survives hot reloads in dev). */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__flowforgePrisma) {
    globalForPrisma.__flowforgePrisma = createPrismaClient();
  }
  return globalForPrisma.__flowforgePrisma;
}
