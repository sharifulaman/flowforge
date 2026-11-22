'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import { createContext, useContext } from 'react';
import type { StepSample } from '@/hooks/use-builder';

export interface TemplateContextValue {
  /** Steps that run before the step being edited (trigger first). */
  previous: StepSample[];
  apps: Map<string, AppManifest>;
}

const Ctx = createContext<TemplateContextValue | null>(null);

export const TemplateProvider = Ctx.Provider;

/** null when templates are not available (e.g. credential forms, trigger settings). */
export function useTemplateContext(): TemplateContextValue | null {
  return useContext(Ctx);
}
