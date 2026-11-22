const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

/** "3 minutes ago", "in 2 hours", "just now". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Date.parse(iso) - now;
  if (Math.abs(diff) < 10_000) return 'just now';
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms || unit === 'second') return rtf.format(Math.round(diff / ms), unit);
  }
  return '—';
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}
