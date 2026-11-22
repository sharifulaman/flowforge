import { describe, expect, it } from 'vitest';
import { groupIssues, setupProblems } from '@/components/builder/builder-utils';
import { defaultsOf, enumLabel, humanize } from '@/components/schema-form/schema-form';
import { coerceJson, coerceNumber, flattenSample, formatReference, insertAt, splitTemplate } from '@/lib/template-utils';
import { formatDuration, relativeTime } from '@/lib/time';

describe('formatReference', () => {
  it('uses dot paths for identifiers and brackets otherwise', () => {
    expect(formatReference('step1', ['body', 'items', 0, 'name'])).toBe('{{ step1.body.items[0].name }}');
    expect(formatReference('trigger', ['headers', 'x-api-key'])).toBe('{{ trigger.headers.x-api-key }}');
    expect(formatReference('trigger', ['body', 'first name'])).toBe('{{ trigger.body["first name"] }}');
    expect(formatReference('trigger', ['body', '0abc'])).toBe('{{ trigger.body["0abc"] }}');
  });
});

describe('flattenSample', () => {
  it('lists nested fields depth-first with previews (first array item only)', () => {
    const fields = flattenSample({ body: { email: 'a@b.co', items: [{ sku: 'X1', qty: 2 }, { sku: 'X2' }] }, ok: true });
    expect(fields.map((f) => [f.label, f.type, f.preview])).toEqual([
      ['body', 'object', '2 fields'],
      ['body › email', 'string', 'a@b.co'],
      ['body › items', 'array', '2 items'],
      ['body › items › 0', 'object', '2 fields'],
      ['body › items › 0 › sku', 'string', 'X1'],
      ['body › items › 0 › qty', 'number', '2'],
      ['ok', 'boolean', 'true'],
    ]);
    expect(fields[4]!.path).toEqual(['body', 'items', 0, 'sku']);
  });

  it('caps depth and count', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(flattenSample(deep, 3).length).toBe(3);
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(flattenSample(wide).length).toBe(300);
  });
});

describe('template text helpers', () => {
  it('splits text into literal and reference parts', () => {
    expect(splitTemplate('Hi {{ trigger.name }}, order {{step1.id}}!')).toEqual([
      { text: 'Hi ', isRef: false },
      { text: '{{ trigger.name }}', isRef: true },
      { text: ', order ', isRef: false },
      { text: '{{step1.id}}', isRef: true },
      { text: '!', isRef: false },
    ]);
  });

  it('inserts at the caret / replaces the selection', () => {
    expect(insertAt('Hello !', '{{ x }}', 6)).toEqual({ value: 'Hello {{ x }}!', caret: 13 });
    expect(insertAt('Hello WORLD', 'there', 6, 11)).toEqual({ value: 'Hello there', caret: 11 });
    expect(insertAt('abc', 'X', 99)).toEqual({ value: 'abcX', caret: 4 });
  });

  it('coerces numeric and JSON inputs without breaking templates', () => {
    expect(coerceNumber('42')).toBe(42);
    expect(coerceNumber('-1.5')).toBe(-1.5);
    expect(coerceNumber('{{ step1.n }}')).toBe('{{ step1.n }}');
    expect(coerceNumber('12abc')).toBe('12abc');
    expect(coerceNumber('')).toBeUndefined();
    expect(coerceJson('{"a":1}')).toEqual({ a: 1 });
    expect(coerceJson('{"a":"{{ step1.x }}"}')).toBe('{"a":"{{ step1.x }}"}');
    expect(coerceJson('{broken')).toBe('{broken');
  });
});

describe('builder utils', () => {
  it('groups publish issues by step', () => {
    const g = groupIssues([
      { path: 'zap', message: 'Add at least one action' },
      { path: 'step1.email', message: 'required' },
      { path: 'step1.connectionId', message: 'Choose an account' },
      { path: 'trigger', message: 'bad' },
    ]);
    expect(g.get('step1')).toEqual([
      { field: 'email', message: 'required' },
      { field: 'connectionId', message: 'Choose an account' },
    ]);
    expect(g.get('zap')).toEqual([{ field: undefined, message: 'Add at least one action' }]);
    expect(g.get('trigger')).toHaveLength(1);
  });

  it('reports client-side setup problems', () => {
    const app = {
      key: 'slack',
      name: 'Slack',
      description: '',
      category: 'communication',
      icon: 'Hash',
      color: '#000',
      auth: { type: 'api_key' as const, available: true },
      triggers: [],
      actions: [
        {
          key: 'send',
          name: 'Send',
          description: '',
          input: { type: 'object' as const, properties: { channel: { type: 'string' as const, title: 'Channel' }, unfurl: { type: 'boolean' as const, default: true } }, required: ['channel', 'unfurl'] },
        },
      ],
    };
    const step = { id: 's', key: 'step1', type: 'ACTION' as const, position: 1, name: null, appKey: 'slack', operationKey: 'send', connectionId: null, config: { channel: '  ' }, timeoutMs: null, sampleOutput: null, sampleAt: null };
    expect(setupProblems(step, app)).toEqual(['Choose an account', 'Channel is required']);
    expect(setupProblems({ ...step, connectionId: 'c', config: { channel: '{{ trigger.ch }}' } }, app)).toEqual([]);
    expect(setupProblems({ ...step, operationKey: 'nope' }, app)).toEqual(['Choose an event']);
  });
});

describe('schema form helpers', () => {
  it('humanizes keys and builds defaults for new array items', () => {
    expect(humanize('spreadsheetId')).toBe('Spreadsheet id');
    expect(humanize('fail_on_error')).toBe('Fail on error');
    expect(enumLabel('POST')).toBe('POST');
    expect(enumLabel('MarkdownV2')).toBe('MarkdownV2');
    expect(enumLabel('not_equals')).toBe('Not equals');
    expect(enumLabel('minutes')).toBe('Minutes');
    expect(defaultsOf({ type: 'object', properties: { operator: { type: 'string', enum: ['equals', 'contains'] }, caseSensitive: { type: 'boolean', default: false }, left: {} }, required: ['operator'] })).toEqual({
      operator: 'equals',
      caseSensitive: false,
    });
  });
});

describe('time helpers', () => {
  it('formats relative times and durations', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(relativeTime('2026-01-01T11:57:00Z', now)).toBe('3 minutes ago');
    expect(relativeTime('2026-01-01T11:59:55Z', now)).toBe('just now');
    expect(relativeTime('2025-12-31T12:00:00Z', now)).toBe('yesterday');
    expect(relativeTime(null)).toBe('—');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(2_345)).toBe('2.35 s');
    expect(formatDuration(95_000)).toBe('1m 35s');
  });
});
