import { defineApp, objectSchema } from '@flowforge/connector-sdk';

/** Run JavaScript in an isolated V8 sandbox (no network, no Node APIs). */
export default defineApp({
  key: 'code',
  name: 'Code',
  description: 'Transform data with JavaScript.',
  category: 'core',
  icon: 'Code',
  color: '#10b981',
  auth: { type: 'none' },
  actions: [
    {
      key: 'runJavascript',
      name: 'Run JavaScript',
      description: 'Your code receives `input` and must `return` a JSON value. `await` and console.log are available.',
      timeoutMs: 10_000,
      input: objectSchema(
        {
          inputData: {
            type: 'object',
            title: 'Input data',
            description: 'Values available as input.<name> in your code.',
            additionalProperties: true,
            'x-ui': { widget: 'keyvalue' },
          },
          code: {
            type: 'string',
            title: 'Code',
            minLength: 1,
            maxLength: 50_000,
            default: '// input.name → "Ada"\nreturn { greeting: `Hello, ${input.name}!` };',
            'x-ui': { widget: 'code', language: 'javascript', noTemplates: true },
          },
        },
        ['code'],
      ),
      sampleOutput: { greeting: 'Hello, Ada!' },
      async run({ input, sandbox, logger }) {
        const emit = (logs: Array<{ level: string; message: string }>) => {
          for (const l of logs) logger[l.level === 'warn' || l.level === 'error' ? l.level : 'info'](l.message);
        };
        let res;
        try {
          res = await sandbox.run(input.code, (input.inputData ?? {}) as Record<string, unknown>, { timeoutMs: 5_000 });
        } catch (err) {
          // The sandbox attaches console output to errors (details.logs): show it in the run.
          const logs = (err as { details?: { logs?: unknown } })?.details?.logs;
          if (Array.isArray(logs)) emit(logs);
          throw err;
        }
        const { result, logs } = res;
        emit(logs);
        // Steps output objects; wrap scalars/arrays so later steps can reference {{ stepN.result }}.
        return result !== null && typeof result === 'object' && !Array.isArray(result) ? result : { result };
      },
    },
  ],
});
