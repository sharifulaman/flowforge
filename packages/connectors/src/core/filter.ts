import { defineApp, FatalError, objectSchema, StopRun } from '@flowforge/connector-sdk';
import { type Condition, describe, evaluate, OPERATORS } from './filter-ops';

/** Continue only if the conditions pass; otherwise the run ends as FILTERED (not failed). */
export default defineApp({
  key: 'filter',
  name: 'Filter',
  description: 'Only continue if a condition is met.',
  category: 'core',
  icon: 'Filter',
  color: '#f59e0b',
  auth: { type: 'none' },
  actions: [
    {
      key: 'onlyContinueIf',
      name: 'Only continue if…',
      description: 'Stops the Zap unless the conditions are met.',
      input: objectSchema(
        {
          match: { type: 'string', enum: ['all', 'any'], 'x-enumLabels': ['All conditions (AND)', 'Any condition (OR)'], default: 'all', 'x-ui': { widget: 'select', noTemplates: true } },
          conditions: {
            type: 'array',
            title: 'Conditions',
            minItems: 1,
            maxItems: 20,
            items: objectSchema(
              {
                left: { title: 'Value', description: 'Usually data from a previous step' },
                operator: { type: 'string', enum: [...OPERATORS], 'x-ui': { widget: 'select', noTemplates: true } },
                right: { title: 'Compare to' },
                caseSensitive: { type: 'boolean', default: false },
              },
              ['left', 'operator'],
            ),
          },
        },
        ['conditions'],
      ),
      sampleOutput: { passed: true, matched: ['"VIP" equals "vip"'] },
      async run({ input }) {
        const conditions = input.conditions as Condition[];
        const results = conditions.map((c) => {
          try {
            return { c, ok: evaluate(c) };
          } catch (err) {
            throw new FatalError(`Invalid condition: ${(err as Error).message}`, 'INVALID_CONDITION');
          }
        });
        const passed = input.match === 'any' ? results.some((r) => r.ok) : results.every((r) => r.ok);
        if (!passed) {
          const failed = results.filter((r) => !r.ok).map((r) => describe(r.c));
          throw new StopRun(`Filter did not pass: ${failed.join(input.match === 'any' ? ' and ' : '; ')}`);
        }
        return { passed: true, matched: results.filter((r) => r.ok).map((r) => describe(r.c)) };
      },
    },
  ],
});
