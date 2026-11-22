import { describe, expect, it } from 'vitest';
import { BUILT_IN_APPS, createDefaultRegistry, nextRuns, validateCron } from '../src';

describe('built-in registry', () => {
  it('loads all apps without definition errors', () => {
    const reg = createDefaultRegistry({});
    expect(reg.all().map((a) => a.key)).toEqual(BUILT_IN_APPS.map((a) => a.key));
    expect(reg.getTrigger('webhook', 'catchHook')?.kind).toBe('webhook');
  });
});

describe('schedule trigger', () => {
  const trigger = createDefaultRegistry({}).getTrigger('schedule', 'every');
  if (trigger?.kind !== 'schedule') throw new Error('schedule trigger missing');

  it('maps config to a repeat spec', () => {
    expect(trigger.schedule({ mode: 'interval', intervalMinutes: 5 })).toEqual({ everyMs: 300_000 });
    expect(trigger.schedule({ mode: 'cron', cron: ' 0 9 * * 1-5 ', timezone: 'Europe/Berlin' })).toEqual({
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
    });
  });

  it('validates cron and timezone', () => {
    expect(trigger.validate!({ mode: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' })).toEqual([]);
    expect(trigger.validate!({ mode: 'cron' })).toEqual([{ field: 'cron', message: 'This field is required' }]);
    expect(trigger.validate!({ mode: 'cron', cron: '* * * * * *' })[0]!.message).toMatch(/5-field/);
    expect(trigger.validate!({ mode: 'cron', cron: '99 * * * *' })[0]!.message).toMatch(/Invalid cron/);
    expect(trigger.validate!({ mode: 'interval', timezone: 'Mars/Olympus' })[0]).toMatchObject({ field: 'timezone' });
  });

  it('computes next runs in a timezone', () => {
    const from = new Date('2026-03-02T00:00:00Z'); // Monday
    const runs = nextRuns('0 9 * * 1-5', 'America/New_York', 2, from);
    expect(runs.map((d) => d.toISOString())).toEqual(['2026-03-02T14:00:00.000Z', '2026-03-03T14:00:00.000Z']);
    expect(validateCron('*/5 * * * *')).toBeNull();
  });
});
