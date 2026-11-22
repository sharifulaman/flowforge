import { z } from 'zod';

export const STATS_RANGES = ['24h', '7d', '30d'] as const;
export const statsQuerySchema = z.object({ range: z.enum(STATS_RANGES).default('7d') });
export type StatsRange = (typeof STATS_RANGES)[number];

export interface StatsTotals {
  total: number;
  succeeded: number;
  failed: number;
  filtered: number;
  canceled: number;
  inProgress: number;
  /** succeeded / (succeeded + failed); null when nothing finished. */
  successRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

export interface StatsBucket {
  /** Bucket start (UTC, ISO). Hourly for 24h, daily otherwise. */
  start: string;
  succeeded: number;
  failed: number;
  filtered: number;
  other: number;
}

export interface StatsDto {
  range: StatsRange;
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  totals: StatsTotals;
  /** Same metrics for the preceding period of equal length (for deltas). */
  previous: Pick<StatsTotals, 'total' | 'failed' | 'successRate'>;
  series: StatsBucket[];
  topFailing: Array<{ zapId: string; name: string; failed: number; lastError: string | null; lastFailedAt: string }>;
  zaps: { active: number; error: number; total: number };
  connectionsNeedingAttention: number;
}
