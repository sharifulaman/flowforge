import type { PrismaClient } from '@flowforge/db';
import type { Worker } from 'bullmq';
import { createServer, type Server } from 'node:http';

/** Tiny liveness/readiness endpoint for container orchestration (GET /health). */
export function startHealthServer(port: number, prisma: PrismaClient, workers: Worker[]): Server {
  const server = createServer(async (req, res) => {
    if (req.url !== '/health') return void res.writeHead(404).end();
    const running = workers.every((w) => w.isRunning());
    const db = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    const ok = running && db;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'degraded', workers: running, postgres: db }));
  });
  server.listen(port);
  return server;
}
