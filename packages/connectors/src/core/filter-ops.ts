/** Pure comparison logic for the Filter step (unit-tested independently). */
export const OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
  'is_true',
  'is_false',
  'matches_regex',
] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  left?: unknown;
  operator: Operator;
  right?: unknown;
  caseSensitive?: boolean;
}

const MAX_REGEX_LENGTH = 200;
const MAX_REGEX_SUBJECT = 10_000;

const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['true', 'yes', '1', 'on'].includes(str(v).trim().toLowerCase());
}

export function evaluate(c: Condition): boolean {
  const fold = (v: unknown) => (c.caseSensitive ? str(v) : str(v).toLowerCase());
  switch (c.operator) {
    case 'equals': {
      const [a, b] = [num(c.left), num(c.right)];
      if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
      return fold(c.left) === fold(c.right);
    }
    case 'not_equals':
      return !evaluate({ ...c, operator: 'equals' });
    case 'contains':
      return Array.isArray(c.left) ? c.left.some((x) => fold(x) === fold(c.right)) : fold(c.left).includes(fold(c.right));
    case 'not_contains':
      return !evaluate({ ...c, operator: 'contains' });
    case 'starts_with':
      return fold(c.left).startsWith(fold(c.right));
    case 'ends_with':
      return fold(c.left).endsWith(fold(c.right));
    case 'greater_than':
    case 'less_than': {
      let [a, b] = [num(c.left), num(c.right)];
      // Fall back to date comparison for ISO strings.
      if (Number.isNaN(a) || Number.isNaN(b)) [a, b] = [Date.parse(str(c.left)), Date.parse(str(c.right))];
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return c.operator === 'greater_than' ? a > b : a < b;
    }
    case 'is_empty':
      return isEmpty(c.left);
    case 'is_not_empty':
      return !isEmpty(c.left);
    case 'is_true':
      return truthy(c.left);
    case 'is_false':
      return !truthy(c.left);
    case 'matches_regex': {
      const pattern = str(c.right);
      if (pattern.length > MAX_REGEX_LENGTH) throw new Error(`Regex is longer than ${MAX_REGEX_LENGTH} characters`);
      return new RegExp(pattern, c.caseSensitive ? '' : 'i').test(str(c.left).slice(0, MAX_REGEX_SUBJECT));
    }
  }
}

export function describe(c: Condition): string {
  const op = c.operator.replace(/_/g, ' ');
  return ['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(c.operator)
    ? `${JSON.stringify(c.left ?? null)} ${op}`
    : `${JSON.stringify(c.left ?? null)} ${op} ${JSON.stringify(c.right ?? null)}`;
}
