import type { FilterCall } from './parser';

type FilterFn = (value: unknown, ...args: Array<string | number | boolean | null>) => unknown;

const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : stringify(v));

export function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Allow-listed filters. Pure functions; no I/O, no code evaluation. */
export const FILTERS: Record<string, FilterFn> = {
  /** Fallback when the value is undefined, null or an empty string. */
  default: (v, fallback = '') => (v === undefined || v === null || v === '' ? fallback : v),
  upper: (v) => str(v).toUpperCase(),
  lower: (v) => str(v).toLowerCase(),
  trim: (v) => str(v).trim(),
  json: (v) => JSON.stringify(v ?? null),
  length: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  join: (v, sep = ', ') => (Array.isArray(v) ? v.map(str).join(String(sep)) : str(v)),
  number: (v) => {
    const n = typeof v === 'number' ? v : Number(str(v).trim());
    return Number.isFinite(n) ? n : null;
  },
  string: (v) => str(v),
  truncate: (v, n = 100) => {
    const s = str(v);
    const max = Math.max(0, Number(n));
    return s.length > max ? `${s.slice(0, max)}…` : s;
  },
};

export class UnknownFilterError extends Error {
  constructor(public readonly filter: string) {
    super(`Unknown filter "${filter}". Available: ${Object.keys(FILTERS).join(', ')}`);
    this.name = 'UnknownFilterError';
  }
}

export function applyFilters(value: unknown, filters: FilterCall[]): unknown {
  let out = value;
  for (const f of filters) {
    const fn = FILTERS[f.name];
    if (!fn) throw new UnknownFilterError(f.name);
    out = fn(out, ...f.args);
  }
  return out;
}
