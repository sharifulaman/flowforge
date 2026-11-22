import { describe, expect, it } from 'vitest';
import {
  analyzeTemplates,
  containsTemplate,
  MissingValueError,
  parseTemplate,
  resolveString,
  resolveTemplates,
  TemplateSyntaxError,
  UnknownFilterError,
} from '../src/templating';

const scope = {
  trigger: {
    body: { email: 'Ada@Example.com', items: [{ name: 'Widget', qty: 2 }, { name: 'Gadget', qty: 5 }], empty: '' },
    headers: { 'x-api-key': 'k1', 'content-type': 'application/json' },
    count: 3,
    ok: true,
    nothing: null,
  },
  step1: { id: 42, tags: ['a', 'b', 'c'], nested: { deep: { value: 'x' } } },
  'step-2': { v: 1 },
};

describe('parseTemplate', () => {
  it('splits text and expressions', () => {
    expect(parseTemplate('Hi {{ trigger.body.email }}!')).toEqual([
      { type: 'text', value: 'Hi ' },
      { type: 'expr', expr: { source: 'trigger.body.email', path: ['trigger', 'body', 'email'], filters: [] } },
      { type: 'text', value: '!' },
    ]);
  });

  it('parses indices, quoted keys and filters with args', () => {
    const [part] = parseTemplate(`{{ trigger.body.items[1]["name"] | default: "n/a" | truncate: 3 }}`);
    expect(part).toMatchObject({
      type: 'expr',
      expr: {
        path: ['trigger', 'body', 'items', 1, 'name'],
        filters: [
          { name: 'default', args: ['n/a'] },
          { name: 'truncate', args: [3] },
        ],
      },
    });
  });

  it('handles "}}" inside quoted filter args', () => {
    const [part] = parseTemplate(`{{ step1.x | default: "}}" }}`);
    expect(part).toMatchObject({ expr: { filters: [{ name: 'default', args: ['}}'] }] } });
  });

  it('supports escaping', () => {
    expect(parseTemplate('literal \\{{ not }}')).toEqual([{ type: 'text', value: 'literal {{ not }}' }]);
  });

  it.each([
    ['{{ trigger.body', /Unclosed/],
    ['{{ }}', /Empty expression/],
    ['{{ trigger. }}', /property name/],
    ['{{ trigger.items[-1] }}', /non-negative/],
    ['{{ trigger.items[x] }}', /quote strings/],
    ['{{ trigger.__proto__.polluted }}', /not allowed/],
    ['{{ trigger["constructor"] }}', /not allowed/],
    ['{{ trigger.a b }}', /Unexpected character/],
    ['{{ 1abc }}', /step name/],
  ])('rejects %s', (input, msg) => {
    expect(() => parseTemplate(input)).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate(input)).toThrow(msg);
  });
});

describe('resolveString', () => {
  it('preserves types for whole-string expressions', () => {
    expect(resolveString('{{ trigger.count }}', scope).value).toBe(3);
    expect(resolveString('{{ trigger.ok }}', scope).value).toBe(true);
    expect(resolveString('{{ step1.tags }}', scope).value).toEqual(['a', 'b', 'c']);
    expect(resolveString('{{ trigger.nothing }}', scope).value).toBeNull();
    expect(resolveString('{{step1.nested}}', scope).value).toEqual({ deep: { value: 'x' } });
  });

  it('interpolates mixed strings, JSON-encoding objects', () => {
    expect(resolveString('Order {{ step1.id }} for {{ trigger.body.email }}', scope).value).toBe(
      'Order 42 for Ada@Example.com',
    );
    expect(resolveString('tags={{ step1.tags }}', scope).value).toBe('tags=["a","b","c"]');
    expect(resolveString('null:{{ trigger.nothing }}.', scope).value).toBe('null:.');
  });

  it('reads arrays, quoted keys, hyphenated roots and .length', () => {
    expect(resolveString('{{ trigger.body.items[1].name }}', scope).value).toBe('Gadget');
    expect(resolveString('{{ trigger.body.items.0.qty }}', scope).value).toBe(2);
    expect(resolveString('{{ trigger.headers["x-api-key"] }}', scope).value).toBe('k1');
    expect(resolveString('{{ step-2.v }}', scope).value).toBe(1);
    expect(resolveString('{{ step1.tags.length }}', scope).value).toBe(3);
  });

  it('reports missing paths (lenient by default)', () => {
    const r = resolveString('Hi {{ trigger.body.missing }} / {{ step9.x }}', scope);
    expect(r.value).toBe('Hi  / ');
    expect(r.missing).toEqual(['trigger.body.missing', 'step9.x']);
    expect(resolveString('{{ trigger.body.items[9] }}', scope).value).toBeUndefined();
  });

  it('throws in strict mode unless a default is provided', () => {
    expect(() => resolveString('{{ trigger.nope }}', scope, { strict: true })).toThrow(MissingValueError);
    expect(resolveString('{{ trigger.nope | default: 7 }}', scope, { strict: true }).value).toBe(7);
  });

  it('never walks the prototype chain', () => {
    expect(resolveString('{{ trigger.body.toString }}', scope).value).toBeUndefined();
    expect(resolveString('{{ trigger.body.hasOwnProperty }}', scope).value).toBeUndefined();
    expect(resolveString('{{ step1.tags.map }}', scope).value).toBeUndefined();
  });

  it('applies filters', () => {
    expect(resolveString('{{ trigger.body.email | lower }}', scope).value).toBe('ada@example.com');
    expect(resolveString('{{ trigger.body.email | upper }}', scope).value).toBe('ADA@EXAMPLE.COM');
    expect(resolveString('{{ trigger.body.empty | default: "none" }}', scope).value).toBe('none');
    expect(resolveString('{{ step1.tags | join: "-" }}', scope).value).toBe('a-b-c');
    expect(resolveString('{{ step1.tags | first }}', scope).value).toBe('a');
    expect(resolveString('{{ step1.tags | last }}', scope).value).toBe('c');
    expect(resolveString('{{ step1.nested | json }}', scope).value).toBe('{"deep":{"value":"x"}}');
    expect(resolveString('{{ step1.id | string }}', scope).value).toBe('42');
    expect(resolveString('{{ trigger.headers | length }}', scope).value).toBe(2);
    expect(resolveString('{{ trigger.body.email | truncate: 3 }}', scope).value).toBe('Ada…');
    expect(resolveString('{{ trigger.body.email | number }}', scope).value).toBeNull();
  });

  it('rejects unknown filters at evaluation time', () => {
    expect(() => resolveString('{{ step1.id | exec }}', scope)).toThrow(UnknownFilterError);
  });

  it('returns plain strings untouched (fast path)', () => {
    expect(resolveString('no templates here', scope)).toEqual({ value: 'no templates here', missing: [] });
  });
});

describe('resolveTemplates (deep)', () => {
  it('resolves nested objects and arrays without mutating input', () => {
    const config = {
      url: 'https://api.example.com/orders/{{ step1.id }}',
      body: { items: '{{ trigger.body.items }}', meta: ['{{ trigger.count }}', 'static'] },
      retries: 3,
      flag: false,
      '{{ not.a.key.template }}': 'keys are literal',
    };
    const frozen = JSON.parse(JSON.stringify(config));
    const { value, missing } = resolveTemplates<typeof config>(config, scope);
    expect(value).toEqual({
      url: 'https://api.example.com/orders/42',
      body: { items: scope.trigger.body.items, meta: [3, 'static'] },
      retries: 3,
      flag: false,
      '{{ not.a.key.template }}': 'keys are literal',
    });
    expect(missing).toEqual([]);
    expect(config).toEqual(frozen);
  });

  it('guards against pathological input', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(() => resolveTemplates(deep, scope)).toThrow(/too deeply/);
    const many = Array.from({ length: 20 }, () => '{{ step1.id }}');
    expect(() => resolveTemplates(many, scope, { maxStrings: 10 })).toThrow(/Too many/);
  });
});

describe('analyzeTemplates', () => {
  it('collects references with locations', () => {
    const { references, issues } = analyzeTemplates({
      to: '{{ trigger.body.email }}',
      text: 'Hi {{ step1.name }} and {{ step2.items[0] }}',
      list: [{ v: '{{ step3.x | default: 1 }}' }],
    });
    expect(issues).toEqual([]);
    expect(references.map((r) => [r.stepKey, r.location])).toEqual([
      ['trigger', 'to'],
      ['step1', 'text'],
      ['step2', 'text'],
      ['step3', 'list.0.v'],
    ]);
    expect(references[2]!.path).toEqual(['items', 0]);
  });

  it('reports syntax errors and unknown filters per location', () => {
    const { issues } = analyzeTemplates({ a: '{{ trigger.x', b: '{{ step1.y | nope }}' });
    expect(issues).toEqual([
      { location: 'a', message: expect.stringMatching(/Unclosed/) },
      { location: 'b', message: 'Unknown filter "nope"' },
    ]);
  });

  it('containsTemplate detects templates deeply', () => {
    expect(containsTemplate({ a: [1, { b: 'x {{ y.z }}' }] })).toBe(true);
    expect(containsTemplate({ a: [1, { b: 'plain' }] })).toBe(false);
  });
});
