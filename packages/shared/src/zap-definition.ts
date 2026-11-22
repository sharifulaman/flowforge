/** Immutable snapshot stored in ZapVersion.definition and executed by the worker. */
export interface StepDefinition {
  key: string;
  name: string | null;
  appKey: string;
  operationKey: string;
  connectionId: string | null;
  config: Record<string, unknown>;
  timeoutMs: number | null;
}

export interface ZapDefinition {
  schemaVersion: 1;
  trigger: StepDefinition;
  steps: StepDefinition[];
}
