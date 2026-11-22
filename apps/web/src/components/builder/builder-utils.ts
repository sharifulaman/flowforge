import type { AppManifest } from '@flowforge/connector-sdk';
import type { StepDto } from '@flowforge/shared';

export interface StepIssue {
  field?: string;
  message: string;
}

/** Publish errors come back as paths "step1.email" / "trigger" / "zap". */
export function groupIssues(issues: Array<{ path: string; message: string }>): Map<string, StepIssue[]> {
  const out = new Map<string, StepIssue[]>();
  for (const i of issues) {
    const [stepKey, ...rest] = i.path.split('.');
    const key = stepKey || 'zap';
    out.set(key, [...(out.get(key) ?? []), { field: rest.length ? rest.join('.') : undefined, message: i.message }]);
  }
  return out;
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Lightweight client-side readiness check (the server does the real validation on publish). */
export function setupProblems(step: StepDto, app: AppManifest | undefined): string[] {
  if (!app) return ['Unknown app'];
  const op = step.type === 'TRIGGER' ? app.triggers.find((t) => t.key === step.operationKey) : app.actions.find((a) => a.key === step.operationKey);
  if (!op) return ['Choose an event'];
  const problems: string[] = [];
  if (app.auth.type !== 'none' && !step.connectionId) problems.push('Choose an account');
  for (const req of op.input.required ?? []) {
    if (blank(step.config[req]) && op.input.properties[req]?.default === undefined) problems.push(`${op.input.properties[req]?.title ?? req} is required`);
  }
  return problems;
}

export function operationOf(step: StepDto, app: AppManifest | undefined) {
  if (!app) return undefined;
  return step.type === 'TRIGGER' ? app.triggers.find((t) => t.key === step.operationKey) : app.actions.find((a) => a.key === step.operationKey);
}
