import { defineApp, FatalError, objectSchema, SuspendRun } from '@flowforge/connector-sdk';

const UNIT_MS = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
export const MAX_DELAY_MS = 30 * UNIT_MS.days;

/** Pauses the run without holding a worker (the engine parks the job until `resumeAt`). */
export default defineApp({
  key: 'delay',
  name: 'Delay',
  description: 'Wait for a while before continuing.',
  category: 'core',
  icon: 'Timer',
  color: '#64748b',
  auth: { type: 'none' },
  actions: [
    {
      key: 'wait',
      name: 'Delay',
      description: 'Wait for a duration or until a date/time (max 30 days).',
      input: objectSchema(
        {
          mode: { type: 'string', enum: ['for', 'until'], 'x-enumLabels': ['Delay for', 'Delay until'], default: 'for', 'x-ui': { widget: 'select', noTemplates: true } },
          amount: { type: 'number', title: 'Amount', minimum: 0, default: 5 },
          unit: { type: 'string', title: 'Unit', enum: Object.keys(UNIT_MS), default: 'minutes', 'x-ui': { widget: 'select' } },
          until: { type: 'string', title: 'Until (ISO date/time)', 'x-ui': { placeholder: '2026-12-24T09:00:00Z' } },
        },
        ['mode'],
      ),
      sampleOutput: { delayedUntil: '2026-01-01T09:05:00.000Z', resumedAt: '2026-01-01T09:05:00.412Z' },
      validate: (c) => (c.mode === 'until' && !c.until ? [{ field: 'until', message: 'This field is required' }] : []),
      async run({ input, isTest }) {
        const now = Date.now();
        let target: number;
        if (input.mode === 'until') {
          target = Date.parse(String(input.until));
          if (Number.isNaN(target)) throw new FatalError(`"${input.until}" is not a valid date/time`, 'INVALID_DATE');
        } else {
          target = now + Number(input.amount ?? 0) * UNIT_MS[(input.unit ?? 'minutes') as keyof typeof UNIT_MS];
        }
        if (target - now > MAX_DELAY_MS) throw new FatalError('Delays are limited to 30 days', 'DELAY_TOO_LONG');
        if (target <= now) return { delayedUntil: new Date(now).toISOString(), resumedAt: new Date(now).toISOString(), skipped: true };
        if (isTest) return { delayedUntil: new Date(target).toISOString(), resumedAt: null, testMode: true };
        throw new SuspendRun(new Date(target));
      },
    },
  ],
});
