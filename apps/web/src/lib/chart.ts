/** Pure helpers for the runs chart (unit-tested). */

/** Round up to a "nice" axis maximum (1, 2, 2.5, 5 × 10^n) with `ticks` intervals. */
export function niceScale(max: number, ticks = 4): { max: number; step: number; ticks: number[] } {
  if (max <= 0) return { max: ticks, step: 1, ticks: Array.from({ length: ticks + 1 }, (_, i) => i) };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = Math.max(1, nice * mag); // runs are integers
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return { max: top, step, ticks: out };
}

/** 1,284 · 12.9K · 4.2M — compact only from 10,000 up. */
export function compactNumber(n: number): string {
  if (Math.abs(n) < 10_000) return n.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function bucketLabel(iso: string, bucket: 'hour' | 'day'): string {
  const d = new Date(iso);
  return bucket === 'hour'
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: 'UTC' }).padStart(2, '0') + ':00'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Show at most ~`max` x labels, evenly spaced. */
export function labelEvery(count: number, max = 8): number {
  return Math.max(1, Math.ceil(count / max));
}

export interface Delta {
  /** Signed change, already in display units (count or percentage points). */
  value: number;
  direction: 'up' | 'down' | 'flat';
  /** Whether this change is good news (drives the color). */
  good: boolean | null;
}

/** Delta vs the previous period. `upIsGood` decides the color; null previous → no delta. */
export function delta(current: number | null, previous: number | null, upIsGood: boolean): Delta | null {
  if (current === null || previous === null) return null;
  const value = current - previous;
  if (Math.abs(value) < 1e-9) return { value: 0, direction: 'flat', good: null };
  const direction = value > 0 ? 'up' : 'down';
  return { value, direction, good: direction === 'up' ? upIsGood : !upIsGood };
}
