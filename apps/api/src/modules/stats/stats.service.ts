import { Injectable } from '@nestjs/common';
import { Prisma } from '@flowforge/db';
import type { StatsBucket, StatsDto, StatsRange, StatsTotals } from '@flowforge/shared';
import { PrismaService } from '../../prisma/prisma.service';

const RANGE: Record<StatsRange, { ms: number; bucket: 'hour' | 'day' }> = {
  '24h': { ms: 24 * 3_600_000, bucket: 'hour' },
  '7d': { ms: 7 * 86_400_000, bucket: 'day' },
  '30d': { ms: 30 * 86_400_000, bucket: 'day' },
};

/** Bucket starts (UTC) covering [from, to]. */
export function bucketStarts(from: Date, to: Date, bucket: 'hour' | 'day'): Date[] {
  const step = bucket === 'hour' ? 3_600_000 : 86_400_000;
  const start = new Date(from);
  if (bucket === 'hour') start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  const out: Date[] = [];
  for (let t = start.getTime(); t <= to.getTime(); t += step) out.push(new Date(t));
  return out;
}

interface TotalsRow {
  total: number;
  succeeded: number;
  failed: number;
  filtered: number;
  canceled: number;
  in_progress: number;
  p50: number | null;
  p95: number | null;
}

/** Workspace-level run statistics. Every query is filtered by workspaceId. */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string, range: StatsRange, now = new Date()): Promise<StatsDto> {
    const { ms, bucket } = RANGE[range];
    const to = now;
    const from = new Date(now.getTime() - ms);
    const prevFrom = new Date(from.getTime() - ms);

    const [current, previous, series, topFailing, zapCounts, connections] = await Promise.all([
      this.totals(workspaceId, from, to),
      this.totals(workspaceId, prevFrom, from),
      this.series(workspaceId, from, to, bucket),
      this.topFailing(workspaceId, from),
      this.prisma.zap.groupBy({ by: ['status'], where: { workspaceId, deletedAt: null }, _count: true }),
      this.prisma.connection.count({ where: { workspaceId, status: { not: 'ACTIVE' } } }),
    ]);

    const zapCount = (s: string) => zapCounts.find((z) => z.status === s)?._count ?? 0;
    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      totals: current,
      previous: { total: previous.total, failed: previous.failed, successRate: previous.successRate },
      series,
      topFailing,
      zaps: { active: zapCount('ACTIVE'), error: zapCount('ERROR'), total: zapCounts.reduce((n, z) => n + z._count, 0) },
      connectionsNeedingAttention: connections,
    };
  }

  private async totals(workspaceId: string, from: Date, to: Date): Promise<StatsTotals> {
    const [row] = await this.prisma.$queryRaw<TotalsRow[]>`
      SELECT
        count(*)::int                                                          AS total,
        count(*) FILTER (WHERE status = 'SUCCEEDED')::int                      AS succeeded,
        count(*) FILTER (WHERE status = 'FAILED')::int                         AS failed,
        count(*) FILTER (WHERE status = 'FILTERED')::int                       AS filtered,
        count(*) FILTER (WHERE status = 'CANCELED')::int                       AS canceled,
        count(*) FILTER (WHERE status IN ('QUEUED', 'RUNNING', 'WAITING'))::int AS in_progress,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE status = 'SUCCEEDED') AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE status = 'SUCCEEDED') AS p95
      FROM "Run"
      WHERE "workspaceId" = ${workspaceId} AND "queuedAt" >= ${from} AND "queuedAt" < ${to}`;
    const r = row!;
    const finished = r.succeeded + r.failed;
    return {
      total: r.total,
      succeeded: r.succeeded,
      failed: r.failed,
      filtered: r.filtered,
      canceled: r.canceled,
      inProgress: r.in_progress,
      successRate: finished ? r.succeeded / finished : null,
      p50DurationMs: r.p50 === null ? null : Math.round(Number(r.p50)),
      p95DurationMs: r.p95 === null ? null : Math.round(Number(r.p95)),
    };
  }

  private async series(workspaceId: string, from: Date, to: Date, bucket: 'hour' | 'day'): Promise<StatsBucket[]> {
    // `bucket` is from a fixed allow-list, so Prisma.raw is safe here.
    const rows = await this.prisma.$queryRaw<Array<{ start: Date; status: string; n: number }>>`
      SELECT date_trunc(${Prisma.raw(`'${bucket}'`)}, "queuedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start, status, count(*)::int AS n
      FROM "Run"
      WHERE "workspaceId" = ${workspaceId} AND "queuedAt" >= ${from} AND "queuedAt" < ${to}
      GROUP BY 1, 2`;
    const byStart = new Map<number, StatsBucket>();
    for (const start of bucketStarts(from, to, bucket)) {
      byStart.set(start.getTime(), { start: start.toISOString(), succeeded: 0, failed: 0, filtered: 0, other: 0 });
    }
    for (const r of rows) {
      const b = byStart.get(new Date(r.start).getTime());
      if (!b) continue;
      if (r.status === 'SUCCEEDED') b.succeeded += r.n;
      else if (r.status === 'FAILED') b.failed += r.n;
      else if (r.status === 'FILTERED') b.filtered += r.n;
      else b.other += r.n;
    }
    return [...byStart.values()];
  }

  private async topFailing(workspaceId: string, from: Date) {
    const rows = await this.prisma.$queryRaw<Array<{ zap_id: string; name: string; failed: number; last_error: string | null; last_failed_at: Date }>>`
      SELECT r."zapId" AS zap_id, z.name, count(*)::int AS failed,
             (array_agg(r.error->>'message' ORDER BY r."queuedAt" DESC))[1] AS last_error,
             max(r."queuedAt") AS last_failed_at
      FROM "Run" r JOIN "Zap" z ON z.id = r."zapId"
      WHERE r."workspaceId" = ${workspaceId} AND r.status = 'FAILED' AND r."queuedAt" >= ${from}
      GROUP BY r."zapId", z.name
      ORDER BY failed DESC, last_failed_at DESC
      LIMIT 5`;
    return rows.map((r) => ({ zapId: r.zap_id, name: r.name, failed: r.failed, lastError: r.last_error, lastFailedAt: new Date(r.last_failed_at).toISOString() }));
  }
}
