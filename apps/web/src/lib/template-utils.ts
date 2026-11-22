/** Helpers for building `{{ step.path }}` references from sample data (field picker). */

export type PathSegment = string | number;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** Render a reference: {{ step1.items[0].name }} / {{ trigger.headers["x-api-key"] }}. */
export function formatReference(stepKey: string, path: PathSegment[]): string {
  let out = stepKey;
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (IDENT.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return `{{ ${out} }}`;
}

export interface SampleField {
  path: PathSegment[];
  /** Human label, e.g. "body › items › 0 › name". */
  label: string;
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  preview: string;
  depth: number;
}

function typeOf(v: unknown): SampleField['type'] {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : (typeof v as SampleField['type']);
}

function preview(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return `${Object.keys(v).length} field${Object.keys(v).length === 1 ? '' : 's'}`;
  return String(v);
}

/**
 * Flatten sample output into selectable fields (depth-first). Objects and arrays are selectable
 * too (they map as whole values). Arrays show only their first item to keep the list short.
 */
export function flattenSample(sample: unknown, maxDepth = 5, maxFields = 300): SampleField[] {
  const out: SampleField[] = [];
  const walk = (v: unknown, path: PathSegment[], depth: number) => {
    if (out.length >= maxFields) return;
    if (path.length) out.push({ path, label: path.join(' › '), type: typeOf(v), preview: preview(v), depth: depth - 1 });
    if (depth >= maxDepth || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (v.length) walk(v[0], [...path, 0], depth + 1);
      return;
    }
    for (const [k, child] of Object.entries(v)) walk(child, [...path, k], depth + 1);
  };
  walk(sample, [], 0);
  return out;
}

export function hasTemplate(v: unknown): boolean {
  return typeof v === 'string' && v.includes('{{');
}

/** Split text into literal and `{{ … }}` parts for highlighting. */
export function splitTemplate(text: string): Array<{ text: string; isRef: boolean }> {
  const parts: Array<{ text: string; isRef: boolean }> = [];
  const re = /\{\{[\s\S]*?\}\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), isRef: false });
    parts.push({ text: m[0], isRef: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), isRef: false });
  return parts;
}

/** For numeric fields: keep numbers as numbers, templates/partial input as strings. */
export function coerceNumber(raw: string): number | string | undefined {
  if (raw.trim() === '') return undefined;
  if (hasTemplate(raw)) return raw;
  const n = Number(raw);
  return Number.isFinite(n) && /^-?\d*\.?\d+(e-?\d+)?$/i.test(raw.trim()) ? n : raw;
}

/** For JSON widgets: parse objects/arrays, keep templates and invalid JSON as strings. */
export function coerceJson(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return undefined;
  if ((t.startsWith('{') || t.startsWith('[')) && !hasTemplate(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function stringifyForInput(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}

/** Insert `snippet` into `value` at the caret, returning the new value and caret position. */
export function insertAt(value: string, snippet: string, start: number, end = start): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  return { value: value.slice(0, s) + snippet + value.slice(e), caret: s + snippet.length };
}
