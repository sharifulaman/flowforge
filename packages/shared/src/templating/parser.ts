/**
 * FlowForge template language.
 *
 *   {{ step1.body.items[0].name }}
 *   {{ trigger.headers["x-api-key"] }}
 *   {{ step2.email | default: "n/a" | lower }}
 *   \{{ not a template }}          (backslash escapes the opening braces)
 *
 * A template is a string mixing literal text and expressions. Expressions are a
 * path (root identifier + property/index accessors) followed by optional filters.
 * There is no arbitrary code execution: paths are read-only property lookups and
 * filters come from a fixed allow-list.
 */

export type PathSegment = string | number;

export interface FilterCall {
  name: string;
  args: Array<string | number | boolean | null>;
}

export interface Expression {
  /** Raw source between the braces, trimmed. */
  source: string;
  /** First segment is the root (e.g. "trigger", "step1"). */
  path: PathSegment[];
  filters: FilterCall[];
}

export type TemplatePart = { type: 'text'; value: string } | { type: 'expr'; expr: Expression };

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(`${message} (at position ${position})`);
    this.name = 'TemplateSyntaxError';
  }
}

/** Property names that must never be traversed. */
export const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$-]/;

/** Fast check used to skip parsing for plain strings. */
export function hasTemplate(input: string): boolean {
  return input.includes('{{');
}

/** Split a string into literal text and expressions. Throws TemplateSyntaxError. */
export function parseTemplate(input: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = '';
  let i = 0;

  const flushText = () => {
    if (text) parts.push({ type: 'text', value: text });
    text = '';
  };

  while (i < input.length) {
    if (input[i] === '\\' && input.startsWith('{{', i + 1)) {
      text += '{{';
      i += 3;
      continue;
    }
    if (input.startsWith('{{', i)) {
      const end = findClosing(input, i + 2);
      if (end === -1) throw new TemplateSyntaxError('Unclosed "{{"', i);
      flushText();
      const source = input.slice(i + 2, end);
      parts.push({ type: 'expr', expr: parseExpression(source, i + 2) });
      i = end + 2;
      continue;
    }
    text += input[i];
    i++;
  }
  flushText();
  return parts;
}

/** Find the matching "}}", skipping over quoted strings. */
function findClosing(input: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < input.length; j++) {
    const ch = input[j]!;
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '}' && input[j + 1] === '}') return j;
  }
  return -1;
}

/** Parse "path | filter: arg, arg | filter". `offset` is only used for error positions. */
export function parseExpression(raw: string, offset = 0): Expression {
  const source = raw.trim();
  if (!source) throw new TemplateSyntaxError('Empty expression', offset);

  const s = new Scanner(raw, offset);
  s.skipWs();
  const path = parsePath(s);
  const filters: FilterCall[] = [];
  s.skipWs();
  while (s.peek() === '|') {
    s.next();
    s.skipWs();
    const name = s.readIdent();
    if (!name) throw s.error('Expected filter name');
    const args: FilterCall['args'] = [];
    s.skipWs();
    if (s.peek() === ':') {
      s.next();
      do {
        s.skipWs();
        args.push(s.readLiteral());
        s.skipWs();
      } while (s.peek() === ',' && s.next());
    }
    filters.push({ name, args });
    s.skipWs();
  }
  if (!s.done()) throw s.error(`Unexpected character "${s.peek()}"`);
  return { source, path, filters };
}

function parsePath(s: Scanner): PathSegment[] {
  const root = s.readIdent();
  if (!root) throw s.error('Expected a step name (e.g. "trigger" or "step1")');
  const path: PathSegment[] = [root];
  for (;;) {
    const ch = s.peek();
    if (ch === '.') {
      s.next();
      const ident = s.readIdent(true);
      if (!ident) throw s.error('Expected property name after "."');
      path.push(ident);
    } else if (ch === '[') {
      s.next();
      s.skipWs();
      const lit = s.readLiteral();
      if (typeof lit === 'number') {
        if (!Number.isInteger(lit) || lit < 0) throw s.error('Array index must be a non-negative integer');
        path.push(lit);
      } else if (typeof lit === 'string') {
        path.push(lit);
      } else {
        throw s.error('Expected index or quoted key inside [...]');
      }
      s.skipWs();
      if (s.peek() !== ']') throw s.error('Expected "]"');
      s.next();
    } else {
      break;
    }
  }
  for (const seg of path) {
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) {
      throw s.error(`Access to "${seg}" is not allowed`);
    }
  }
  return path;
}

class Scanner {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly offset: number,
  ) {}

  peek(): string | undefined {
    return this.src[this.i];
  }
  next(): string | undefined {
    return this.src[this.i++];
  }
  done(): boolean {
    this.skipWs();
    return this.i >= this.src.length;
  }
  skipWs(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
  }
  error(msg: string): TemplateSyntaxError {
    return new TemplateSyntaxError(msg, this.offset + this.i);
  }

  /** Identifier; after a "." we also allow names starting with a digit (e.g. `.0abc`, `.123`). */
  readIdent(afterDot = false): string {
    const start = this.i;
    const first = this.peek();
    if (!first) return '';
    if (!(IDENT_START.test(first) || (afterDot && /[0-9]/.test(first)))) return '';
    this.i++;
    while (this.i < this.src.length && IDENT_PART.test(this.src[this.i]!)) this.i++;
    return this.src.slice(start, this.i);
  }

  readLiteral(): string | number | boolean | null {
    const ch = this.peek();
    if (ch === '"' || ch === "'") {
      this.next();
      let out = '';
      for (;;) {
        const c = this.next();
        if (c === undefined) throw this.error('Unterminated string');
        if (c === '\\') {
          const esc = this.next();
          if (esc === undefined) throw this.error('Unterminated string');
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          continue;
        }
        if (c === ch) return out;
        out += c;
      }
    }
    const m = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return Number(m[0]);
    }
    const word = this.readIdent();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    throw this.error(word ? `Unexpected word "${word}" (quote strings)` : 'Expected a value');
  }
}
