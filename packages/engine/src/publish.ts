import { validateConfig, type ConnectorRegistry } from '@flowforge/connector-sdk';
import { analyzeTemplates, type PublishIssue, type ReferenceWarning, type StepDefinition, type ZapDefinition } from '@flowforge/shared';
import { canonicalJson } from './canonical-json';

export interface DraftStep {
  key: string;
  type: 'TRIGGER' | 'ACTION';
  position: number;
  name: string | null;
  appKey: string;
  operationKey: string;
  connectionId: string | null;
  config: unknown;
  timeoutMs: number | null;
}

export interface ConnectionRef {
  id: string;
  appKey: string;
  status: 'ACTIVE' | 'ERROR' | 'EXPIRED';
}

export const MAX_ACTIONS = 50;

function sortSteps(steps: DraftStep[]): { trigger?: DraftStep; actions: DraftStep[] } {
  const trigger = steps.find((s) => s.type === 'TRIGGER');
  const actions = steps.filter((s) => s.type === 'ACTION').sort((a, b) => a.position - b.position);
  return { trigger, actions };
}

/**
 * References that point at unknown steps or at steps that run later. Used both as
 * hard errors at publish time and as soft warnings while editing (e.g. after reorder).
 */
export function findReferenceProblems(steps: DraftStep[]): ReferenceWarning[] {
  const { trigger, actions } = sortSteps(steps);
  const ordered = [...(trigger ? [trigger] : []), ...actions];
  const index = new Map(ordered.map((s, i) => [s.key, i]));
  const problems: ReferenceWarning[] = [];

  ordered.forEach((step, i) => {
    const { references } = analyzeTemplates(step.config);
    for (const ref of references) {
      const target = index.get(ref.stepKey);
      if (target === undefined) {
        problems.push({ stepKey: step.key, location: ref.location, message: `"{{ ${ref.source} }}" refers to unknown step "${ref.stepKey}"` });
      } else if (target >= i) {
        problems.push({
          stepKey: step.key,
          location: ref.location,
          message:
            target === i
              ? `"{{ ${ref.source} }}" refers to this step itself`
              : `"{{ ${ref.source} }}" uses data from "${ref.stepKey}", which runs after this step`,
        });
      }
    }
  });
  return problems;
}

/** Everything that must hold before a zap can be turned on. Empty array = publishable. */
export function validateForPublish(
  steps: DraftStep[],
  registry: ConnectorRegistry,
  connections: Map<string, ConnectionRef>,
): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const { trigger, actions } = sortSteps(steps);

  if (!trigger) issues.push({ stepKey: null, message: 'Add a trigger to start this Zap' });
  if (actions.length === 0) issues.push({ stepKey: null, message: 'Add at least one action' });
  if (actions.length > MAX_ACTIONS) issues.push({ stepKey: null, message: `A Zap can have at most ${MAX_ACTIONS} actions` });

  for (const step of [...(trigger ? [trigger] : []), ...actions]) {
    const app = registry.get(step.appKey);
    if (!app) {
      issues.push({ stepKey: step.key, message: `Unknown app "${step.appKey}"` });
      continue;
    }
    const op = step.type === 'TRIGGER' ? registry.getTrigger(step.appKey, step.operationKey) : registry.getAction(step.appKey, step.operationKey);
    if (!op) {
      issues.push({ stepKey: step.key, message: `${app.name} has no ${step.type === 'TRIGGER' ? 'trigger' : 'action'} "${step.operationKey}"` });
      continue;
    }

    if (app.auth.type !== 'none') {
      if (!step.connectionId) {
        issues.push({ stepKey: step.key, field: 'connectionId', message: `Choose a ${app.name} account` });
      } else {
        const conn = connections.get(step.connectionId);
        if (!conn || conn.appKey !== step.appKey) {
          issues.push({ stepKey: step.key, field: 'connectionId', message: 'The selected account no longer exists' });
        } else if (conn.status === 'EXPIRED') {
          issues.push({ stepKey: step.key, field: 'connectionId', message: `The ${app.name} account needs to be reconnected` });
        }
      }
    }

    const config = (step.config ?? {}) as Record<string, unknown>;
    if (step.type === 'TRIGGER') {
      const { references } = analyzeTemplates(config);
      if (references.length) issues.push({ stepKey: step.key, message: 'Trigger settings cannot use data from other steps' });
    }
    for (const i of validateConfig(op.input, config)) issues.push({ stepKey: step.key, field: i.field || undefined, message: i.message });
    for (const i of op.validate?.(config) ?? []) issues.push({ stepKey: step.key, field: i.field, message: i.message });
    for (const i of analyzeTemplates(config).issues) issues.push({ stepKey: step.key, field: i.location || undefined, message: i.message });
  }

  for (const p of findReferenceProblems(steps)) {
    if (p.stepKey !== trigger?.key) issues.push({ stepKey: p.stepKey, field: p.location || undefined, message: p.message });
  }
  return issues;
}

function toStepDefinition(s: DraftStep): StepDefinition {
  return {
    key: s.key,
    name: s.name,
    appKey: s.appKey,
    operationKey: s.operationKey,
    connectionId: s.connectionId,
    config: (s.config ?? {}) as Record<string, unknown>,
    timeoutMs: s.timeoutMs,
  };
}

/** Immutable snapshot of a (validated) draft. */
export function buildDefinition(steps: DraftStep[]): ZapDefinition {
  const { trigger, actions } = sortSteps(steps);
  if (!trigger) throw new Error('Cannot build a definition without a trigger');
  return { schemaVersion: 1, trigger: toStepDefinition(trigger), steps: actions.map(toStepDefinition) };
}

export function definitionsEqual(a: ZapDefinition | null | undefined, b: ZapDefinition | null | undefined): boolean {
  if (!a || !b) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

/** Draft differs from the published snapshot? (a draft without a trigger always differs) */
export function hasUnpublishedChanges(steps: DraftStep[], published: ZapDefinition | null): boolean {
  if (!published) return steps.length > 0;
  if (!steps.some((s) => s.type === 'TRIGGER')) return true;
  return !definitionsEqual(buildDefinition(steps), published);
}
