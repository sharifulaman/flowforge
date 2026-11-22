import { defineApp, objectSchema, type ValidationIssue } from '@flowforge/connector-sdk';
import parser from 'cron-parser';

export const MIN_INTERVAL_MINUTES = 1;

export interface ScheduleConfig {
  mode: 'interval' | 'cron';
  intervalMinutes?: number;
  cron?: string;
  timezone?: string;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates a 5-field cron expression and that it fires at most once a minute. */
export function validateCron(expr: string, timezone = 'UTC'): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return 'Use a 5-field cron expression (minute hour day month weekday)';
  try {
    parser.parseExpression(expr, { tz: timezone });
    return null;
  } catch (err) {
    return `Invalid cron expression: ${(err as Error).message}`;
  }
}

/** Next `n` fire times — used by the UI preview and tests. */
export function nextRuns(expr: string, timezone = 'UTC', n = 3, from = new Date()): Date[] {
  const it = parser.parseExpression(expr, { tz: timezone, currentDate: from });
  return Array.from({ length: n }, () => it.next().toDate());
}

export default defineApp({
  key: 'schedule',
  name: 'Schedule',
  description: 'Run a Zap on a recurring schedule.',
  category: 'core',
  icon: 'CalendarClock',
  color: '#8b5cf6',
  auth: { type: 'none' },
  triggers: [
    {
      key: 'every',
      name: 'Run on a schedule',
      kind: 'schedule',
      description: 'Fires every N minutes, or on a cron schedule in your timezone.',
      input: objectSchema(
        {
          mode: {
            type: 'string',
            title: 'Repeat',
            enum: ['interval', 'cron'],
            'x-enumLabels': ['Every N minutes', 'Cron expression'],
            default: 'interval',
            'x-ui': { widget: 'select', noTemplates: true },
          },
          intervalMinutes: {
            type: 'integer',
            title: 'Every (minutes)',
            minimum: MIN_INTERVAL_MINUTES,
            maximum: 10_080,
            default: 15,
            'x-ui': { widget: 'number', noTemplates: true },
          },
          cron: {
            type: 'string',
            title: 'Cron expression',
            description: 'minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5" for weekdays at 9:00',
            'x-ui': { widget: 'cron', placeholder: '0 9 * * 1-5', noTemplates: true },
          },
          timezone: {
            type: 'string',
            title: 'Timezone',
            default: 'UTC',
            'x-ui': { placeholder: 'Europe/Berlin', noTemplates: true },
          },
        },
        ['mode'],
      ),
      sampleOutput: {
        firedAt: '2026-01-01T09:00:00.123Z',
        scheduledFor: '2026-01-01T09:00:00.000Z',
        timezone: 'UTC',
      },
      validate(config: Partial<ScheduleConfig>): ValidationIssue[] {
        const issues: ValidationIssue[] = [];
        const tz = config.timezone ?? 'UTC';
        if (!isValidTimezone(tz)) issues.push({ field: 'timezone', message: `Unknown timezone "${tz}"` });
        if (config.mode === 'cron') {
          if (!config.cron) issues.push({ field: 'cron', message: 'This field is required' });
          else {
            const err = validateCron(config.cron, isValidTimezone(tz) ? tz : 'UTC');
            if (err) issues.push({ field: 'cron', message: err });
          }
        } else if (config.intervalMinutes === undefined) {
          // Schema default applies; nothing to check.
        }
        return issues;
      },
      schedule(config: ScheduleConfig) {
        if (config.mode === 'cron') return { cron: config.cron!.trim(), timezone: config.timezone ?? 'UTC' };
        return { everyMs: (config.intervalMinutes ?? 15) * 60_000 };
      },
    },
  ],
});
