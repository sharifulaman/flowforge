'use client';

import { createContext, useContext } from 'react';

export interface BuilderActions {
  select: (stepId: string | null) => void;
  /** Open the picker to insert an action after `afterKey` ("trigger" = first). */
  insertAfter: (afterKey: string) => void;
  chooseTrigger: () => void;
}

const Ctx = createContext<BuilderActions | null>(null);
export const BuilderActionsProvider = Ctx.Provider;
export const useBuilderActions = () => useContext(Ctx)!;
