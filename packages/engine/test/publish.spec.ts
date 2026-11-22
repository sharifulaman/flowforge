import { describe, expect, it } from 'vitest';
import { buildDefinition, type ConnectionRef, type DraftStep, findReferenceProblems, hasUnpublishedChanges, validateForPublish } from '../src';
import { testRegistry } from './fixtures';

const registry = testRegistry();
const conns = new Map<string, ConnectionRef>([
  ['conn_ok', { id: 'conn_ok', appKey: 'acme', status: 'ACTIVE' }],
  ['conn_expired', { id: 'conn_expired', appKey: 'acme', status: 'EXPIRED' }],
  ['conn_other', { id: 'conn_other', appKey: 'oauthy', status: 'ACTIVE' }],
]);

const step = (over: Partial<DraftStep>): DraftStep => ({
  key: 'step1',
  type: 'ACTION',
  position: 1,
  name: null,
  appKey: 'acme',
  operationKey: 'send',
  connectionId: 'conn_ok',
  config: { to: 'a@b.co' },
  timeoutMs: null,
  ...over,
});
const trigger = step({ key: 'trigger', type: 'TRIGGER', position: 0, appKey: 'webhook', operationKey: 'catchHook', connectionId: null, config: {} });

describe('validateForPublish', () => {
  it('passes a valid zap', () => {
    const steps = [trigger, step({ config: { to: '{{ trigger.body.email }}' } }), step({ key: 'step2', position: 2, config: { to: '{{ step1.to }}' } })];
    expect(validateForPublish(steps, registry, conns)).toEqual([]);
  });

  it('requires a trigger and an action', () => {
    expect(validateForPublish([], registry, conns).map((i) => i.message)).toEqual([
      'Add a trigger to start this Zap',
      'Add at least one action',
    ]);
  });

  it('reports unknown apps/operations', () => {
    const issues = validateForPublish([trigger, step({ appKey: 'ghost' }), step({ key: 'step2', position: 2, operationKey: 'nope' })], registry, conns);
    expect(issues).toEqual([
      { stepKey: 'step1', message: 'Unknown app "ghost"' },
      { stepKey: 'step2', message: 'Acme has no action "nope"' },
    ]);
  });

  it('checks connections: missing, wrong app, expired', () => {
    const issues = validateForPublish(
      [
        trigger,
        step({ connectionId: null }),
        step({ key: 'step2', position: 2, connectionId: 'conn_other' }),
        step({ key: 'step3', position: 3, connectionId: 'conn_expired' }),
      ],
      registry,
      conns,
    );
    expect(issues.map((i) => [i.stepKey, i.message])).toEqual([
      ['step1', 'Choose a Acme account'],
      ['step2', 'The selected account no longer exists'],
      ['step3', 'The Acme account needs to be reconnected'],
    ]);
  });

  it('validates configs against the schema (templates exempt) and custom validators', () => {
    const issues = validateForPublish(
      [
        step({ key: 'trigger', type: 'TRIGGER', position: 0, appKey: 'schedule', operationKey: 'every', connectionId: null, config: { mode: 'cron', cron: 'bad' } }),
        step({ config: { to: 'not-email', count: '{{ trigger.n }}' } }),
      ],
      registry,
      conns,
    );
    expect(issues).toEqual([
      { stepKey: 'trigger', field: 'cron', message: expect.stringMatching(/5-field/) },
      { stepKey: 'step1', field: 'to', message: expect.stringMatching(/email/) },
    ]);
  });

  it('rejects forward, self and unknown references, bad syntax, and templated triggers', () => {
    const issues = validateForPublish(
      [
        step({ key: 'trigger', type: 'TRIGGER', position: 0, appKey: 'acme', operationKey: 'newThing', connectionId: 'conn_ok', config: { channel: '{{ step1.x }}' } }),
        step({ config: { to: '{{ step2.to }}' } }),
        step({ key: 'step2', position: 2, config: { to: '{{ step2.to }} {{ step9.x }}' } }),
        step({ key: 'step3', position: 3, config: { to: '{{ trigger.x' } }),
      ],
      registry,
      conns,
    );
    expect(issues.map((i) => i.message)).toEqual([
      'Trigger settings cannot use data from other steps',
      expect.stringMatching(/Unclosed/),
      '"{{ step2.to }}" uses data from "step2", which runs after this step',
      '"{{ step2.to }}" refers to this step itself',
      '"{{ step9.x }}" refers to unknown step "step9"',
    ]);
  });
});

describe('findReferenceProblems', () => {
  it('flags references broken by reordering', () => {
    const steps = [trigger, step({ key: 'step2', position: 1, config: { to: '{{ step1.to }}' } }), step({ key: 'step1', position: 2 })];
    expect(findReferenceProblems(steps)).toEqual([
      { stepKey: 'step2', location: 'to', message: '"{{ step1.to }}" uses data from "step1", which runs after this step' },
    ]);
  });
});

describe('definitions', () => {
  it('builds an ordered snapshot and detects drift', () => {
    const steps = [step({ key: 'step2', position: 2 }), trigger, step({})];
    const def = buildDefinition(steps);
    expect(def.trigger.key).toBe('trigger');
    expect(def.steps.map((s) => s.key)).toEqual(['step1', 'step2']);
    expect(hasUnpublishedChanges(steps, def)).toBe(false);
    // Key order inside config must not matter.
    const reordered = steps.map((s) => (s.key === 'step1' ? { ...s, config: { count: undefined, to: 'a@b.co' } } : s));
    expect(hasUnpublishedChanges(reordered, def)).toBe(false);
    expect(hasUnpublishedChanges([...steps.slice(0, 2), step({ config: { to: 'x@y.z' } })], def)).toBe(true);
    expect(hasUnpublishedChanges(steps, null)).toBe(true);
  });
});
