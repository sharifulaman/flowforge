import type { TriggerManager } from '@flowforge/engine';
import { type DraftStep, findReferenceProblems, hasUnpublishedChanges } from '@flowforge/engine';
import type { TriggerState, Zap, ZapStep } from '@flowforge/db';
import type { StepDto, ZapDefinition, ZapDetailDto, ZapSummaryDto } from '@flowforge/shared';
import { iso } from '../../common/serialize';

export type ZapWithRelations = Zap & {
  steps: ZapStep[];
  triggerState: TriggerState | null;
  publishedVersion: { version: number; definition: unknown } | null;
};

export function sortedSteps(steps: ZapStep[]): ZapStep[] {
  return [...steps].sort((a, b) => (a.type === b.type ? a.position - b.position : a.type === 'TRIGGER' ? -1 : 1));
}

export function toDraftSteps(steps: ZapStep[]): DraftStep[] {
  return steps.map((s) => ({
    key: s.key,
    type: s.type,
    position: s.position,
    name: s.name,
    appKey: s.appKey,
    operationKey: s.operationKey,
    connectionId: s.connectionId,
    config: s.config,
    timeoutMs: s.timeoutMs,
  }));
}

export function toStepDto(s: ZapStep): StepDto {
  return {
    id: s.id,
    key: s.key,
    type: s.type,
    position: s.position,
    name: s.name,
    appKey: s.appKey,
    operationKey: s.operationKey,
    connectionId: s.connectionId,
    config: (s.config ?? {}) as Record<string, unknown>,
    timeoutMs: s.timeoutMs,
    sampleOutput: s.sampleOutput ?? null,
    sampleAt: iso(s.sampleAt),
  };
}

export function toZapSummary(z: Zap & { steps: Pick<ZapStep, 'appKey' | 'type' | 'position'>[]; publishedVersion: { version: number } | null }): ZapSummaryDto {
  const ordered = [...z.steps].sort((a, b) => (a.type === b.type ? a.position - b.position : a.type === 'TRIGGER' ? -1 : 1));
  return {
    id: z.id,
    name: z.name,
    description: z.description,
    status: z.status,
    apps: ordered.map((s) => s.appKey),
    publishedVersion: z.publishedVersion?.version ?? null,
    createdAt: iso(z.createdAt)!,
    updatedAt: iso(z.updatedAt)!,
  };
}

export function toZapDetail(z: ZapWithRelations, triggers: TriggerManager): ZapDetailDto {
  const steps = sortedSteps(z.steps);
  const drafts = toDraftSteps(steps);
  const state = z.triggerState;
  return {
    ...toZapSummary(z),
    steps: steps.map(toStepDto),
    trigger: {
      kind: state?.kind ?? null,
      hookUrl: triggers.hookUrl(state?.kind, state?.hookToken),
      lastFiredAt: iso(state?.lastFiredAt),
      lastError: state?.lastError ?? null,
    },
    hasUnpublishedChanges: hasUnpublishedChanges(drafts, (z.publishedVersion?.definition as ZapDefinition | undefined) ?? null),
    warnings: findReferenceProblems(drafts),
  };
}

export const zapDetailInclude = {
  steps: true,
  triggerState: true,
  publishedVersion: { select: { version: true, definition: true } },
} as const;
