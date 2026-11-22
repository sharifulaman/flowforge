import { applyFilters, stringify } from './filters';
import { type Expression, FORBIDDEN_SEGMENTS, hasTemplate, parseTemplate, type PathSegment, type TemplatePart } from './parser';

/** Data available to templates: `{ trigger: {...}, step1: {...}, ... }`. */
export type TemplateScope = Record<string, unknown>;

export interface ResolveOptions {
  /** Throw on missing paths instead of resolving them to undefined / "". */
  strict?: boolean;
  /** Max template-bearing strings processed (defends against pathological configs). */
  maxStrings?: number;
}

export interface ResolveResult<T = unknown> {
  value: T;
  /** Expressions whose path did not resolve. */
  missing: string[];
}

export class MissingValueError extends Error {
  constructor(public readonly expression: string) {
    super(`No value for {{ ${expression} }}`);
    this.name = 'MissingValueError';
  }
}

const MISSING = Symbol('missing');

/** Safe own-property lookup. Never walks the prototype chain. */
export function getPath(root: unknown, path: PathSegment[]): unknown | typeof MISSING {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return MISSING;
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) return MISSING;
    if (Array.isArray(cur)) {
      const idx = typeof seg === 'number' ? seg : /^\d+$/.test(seg) ? Number(seg) : NaN;
      if (Number.isNaN(idx)) {
        if (seg === 'length') {
          cur = cur.length;
          continue;
        }
        return MISSING;
      }
      if (idx >= cur.length) return MISSING;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return MISSING;
    const key = String(seg);
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return MISSING;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function evaluate(expr: Expression, scope: TemplateScope, missing: string[], strict: boolean): unknown {
  let value = getPath(scope, expr.path);
  if (value === MISSING) {
    // Filters like `default` may still provide a value.
    if (strict && !expr.filters.some((f) => f.name === 'default')) throw new MissingValueError(expr.source);
    missing.push(expr.source);
    value = undefined;
  }
  return applyFilters(value, expr.filters);
}

function renderParts(parts: TemplatePart[], scope: TemplateScope, missing: string[], strict: boolean): unknown {
  // A string that is exactly one expression keeps the value's type (arrays, numbers, objects…).
  if (parts.length === 1 && parts[0]!.type === 'expr') {
    return evaluate(parts[0]!.expr, scope, missing, strict);
  }
  let out = '';
  for (const part of parts) {
    out += part.type === 'text' ? part.value : stringify(evaluate(part.expr, scope, missing, strict));
  }
  return out;
}

/** Resolve a single string. */
export function resolveString(input: string, scope: TemplateScope, opts: ResolveOptions = {}): ResolveResult {
  const missing: string[] = [];
  if (!hasTemplate(input)) return { value: input, missing };
  return { value: renderParts(parseTemplate(input), scope, missing, opts.strict ?? false), missing };
}

/**
 * Deep-resolve templates in any JSON-like value (objects, arrays, strings).
 * Object keys are never templated. Returns a new value; the input is not mutated.
 */
export function resolveTemplates<T = unknown>(input: unknown, scope: TemplateScope, opts: ResolveOptions = {}): ResolveResult<T> {
  const missing: string[] = [];
  const strict = opts.strict ?? false;
  let budget = opts.maxStrings ?? 10_000;

  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error('Template input is nested too deeply');
    if (typeof v === 'string') {
      if (!hasTemplate(v)) return v;
      if (--budget < 0) throw new Error('Too many template strings');
      return renderParts(parseTemplate(v), scope, missing, strict);
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, depth + 1);
      return out;
    }
    return v;
  };

  return { value: walk(input, 0) as T, missing };
}
