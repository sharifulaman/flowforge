import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../../redis/redis.module';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up. */
  @Get()
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /** Readiness: dependencies reachable. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const check = async (fn: () => Promise<unknown>) => {
      const started = Date.now();
      try {
        await Promise.race([
          fn(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
        ]);
        return { ok: true, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    };
    const [postgres, redis] = await Promise.all([
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => this.redis.ping()),
    ]);
    const ok = postgres.ok && redis.ok;
    reply.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', checks: { postgres, redis } };
  }
}
