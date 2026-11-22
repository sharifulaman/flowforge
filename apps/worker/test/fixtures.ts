import { ConnectorRegistry, defineApp, FatalError, objectSchema, RetryableError, SuspendRun } from '@flowforge/connector-sdk';
import { BUILT_IN_APPS } from '@flowforge/connectors';

export const counters: Record<string, number> = {};
export const pollItems: Array<{ id: string; data: Record<string, unknown> }> = [];
const bump = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);

export const kit = defineApp({
  key: 'kit',
  name: 'Kit',
  description: 'Worker test kit',
  category: 'developer',
  icon: 'Wrench',
  color: '#000000',
  auth: { type: 'none' },
  triggers: [
    {
      key: 'poll',
      name: 'Poll',
      description: 'Polling fixture',
      kind: 'polling',
      intervalSeconds: 60,
      input: objectSchema({}),
      poll: async () => ({ items: [...pollItems] }),
    },
  ],
  actions: [
    { key: 'echo', name: 'Echo', description: 'Echo', input: { type: 'object', properties: {}, additionalProperties: true }, run: async ({ input }) => ({ ...input }) },
    {
      key: 'flaky',
      name: 'Flaky',
      description: 'Fails N times',
      input: objectSchema({ times: { type: 'integer' }, key: { type: 'string' } }, ['times', 'key']),
      run: async ({ input }) => {
        const n = bump(`flaky:${input.key}`);
        if (n <= (input.times as number)) throw new RetryableError(`transient #${n}`);
        return { call: n };
      },
    },
    { key: 'boom', name: 'Boom', description: 'Fatal', input: objectSchema({}), run: async () => { throw new FatalError('nope'); } },
    {
      key: 'wait',
      name: 'Wait',
      description: 'Delay',
      input: objectSchema({ ms: { type: 'integer' } }, ['ms']),
      run: async ({ input }) => {
        bump('wait');
        throw new SuspendRun(new Date(Date.now() + (input.ms as number)));
      },
    },
    {
      key: 'code',
      name: 'Code',
      description: 'Runs JS in the sandbox',
      input: objectSchema({ code: { type: 'string' }, data: { type: 'object', additionalProperties: true } }, ['code']),
      run: async ({ input, sandbox, logger }) => {
        const r = await sandbox.run(input.code as string, (input.data as Record<string, unknown>) ?? {});
        for (const l of r.logs) logger.info(l.message);
        return r.result;
      },
    },
  ],
});

export const registry = () => new ConnectorRegistry([...BUILT_IN_APPS, kit]);
