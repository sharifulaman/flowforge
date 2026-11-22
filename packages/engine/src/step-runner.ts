import { type ActionDefinition, type ConnectorLogger, type ConnectorRegistry, FatalError, RetryableError, type Sandbox, validateInput } from '@flowforge/connector-sdk';
import { resolveTemplates, type StepDefinition, type TemplateScope } from '@flowforge/shared';
import type { CredentialStore } from './credentials';
import { classifyError, type ErrorClass, StepTimeoutError } from './errors';
import type { SafeHttpClient } from '@flowforge/safe-http';

export const DEFAULT_STEP_TIMEOUT_MS = 30_000;
export const MIN_STEP_TIMEOUT_MS = 1_000;
export const MAX_STEP_TIMEOUT_MS = 300_000;
export const MAX_STEP_OUTPUT_BYTES = 1024 * 1024;
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_MESSAGE = 2_000;

export interface StepLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
  at: string;
}

export interface StepRunnerDeps {
  registry: ConnectorRegistry;
  credentials: CredentialStore;
  http: SafeHttpClient;
  sandbox: Sandbox;
}

export interface StepInvocation {
  workspaceId: string;
  runId: string;
  step: StepDefinition;
  scope: TemplateScope;
  isTest?: boolean;
  /** External cancellation (e.g. worker shutdown). */
  signal?: AbortSignal;
}

export type StepResult =
  | { ok: true; input: unknown; output: unknown; logs: StepLog[]; durationMs: number }
  | { ok: false; input: unknown; failure: ErrorClass; logs: StepLog[]; durationMs: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function effectiveTimeout(step: Pick<StepDefinition, 'timeoutMs'>, action?: Pick<ActionDefinition, 'timeoutMs'>): number {
  const ms = step.timeoutMs ?? action?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  return Math.min(Math.max(ms, MIN_STEP_TIMEOUT_MS), MAX_STEP_TIMEOUT_MS);
}

/** Normalize step output to plain JSON and enforce the size cap. */
export function normalizeOutput(value: unknown): unknown {
  if (value === undefined || value === null) return {};
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new FatalError('Step output is not JSON-serializable', 'OUTPUT_NOT_SERIALIZABLE');
  }
  if (json === undefined) return {};
  if (Buffer.byteLength(json) > MAX_STEP_OUTPUT_BYTES) {
    throw new FatalError(`Step output exceeds ${MAX_STEP_OUTPUT_BYTES / 1024 / 1024} MB`, 'OUTPUT_TOO_LARGE');
  }
  return JSON.parse(json);
}

function captureLogger(logs: StepLog[]): ConnectorLogger {
  const push = (level: StepLog['level']) => (message: string, data?: Record<string, unknown>) => {
    if (logs.length >= MAX_LOG_ENTRIES) return;
    logs.push({ level, message: String(message).slice(0, MAX_LOG_MESSAGE), ...(data ? { data } : {}), at: new Date().toISOString() });
  };
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

/**
 * Execute one action step: resolve {{templates}} against prior outputs, validate the resolved
 * input against the action's schema, load credentials, run with a timeout, normalize output.
 * Never throws for step-level failures — returns a classified failure instead.
 */
export async function runActionStep(deps: StepRunnerDeps, inv: StepInvocation): Promise<StepResult> {
  const started = Date.now();
  const logs: StepLog[] = [];
  const logger = captureLogger(logs);
  let input: unknown = null;
  const done = (r: DistributiveOmit<StepResult, 'logs' | 'durationMs'>): StepResult => ({ ...r, logs, durationMs: Date.now() - started }) as StepResult;

  const { step } = inv;
  const app = deps.registry.get(step.appKey);
  const action = deps.registry.getAction(step.appKey, step.operationKey);
  if (!app || !action) {
    return done({ ok: false, input, failure: { kind: 'fatal', error: { message: `Unknown action ${step.appKey}.${step.operationKey}`, code: 'UNKNOWN_ACTION' } } });
  }

  const timeoutMs = effectiveTimeout(step, action);
  // One controller drives cancellation: step timeout, or external abort (worker shutdown).
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(new RetryableError('Worker is shutting down; the step will be retried'));
  if (inv.signal?.aborted) onExternalAbort();
  inv.signal?.addEventListener('abort', onExternalAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;

  try {
    const resolved = resolveTemplates<Record<string, unknown>>(step.config ?? {}, inv.scope);
    input = resolved.value;
    for (const m of resolved.missing) logger.warn(`No value for {{ ${m} }} — used empty value`);

    const valid = validateInput(action.input, resolved.value);
    if (!valid.ok) {
      throw new FatalError(`Invalid input: ${valid.issues.map((i) => `${i.field || 'input'} ${i.message}`).join('; ')}`, 'INVALID_INPUT', valid.issues);
    }
    input = valid.value;

    let auth: Record<string, unknown> = {};
    if (app.auth.type !== 'none') {
      if (!step.connectionId) throw new FatalError(`No ${app.name} account selected for this step`, 'NO_CONNECTION');
      auth = await deps.credentials.getAuth(inv.workspaceId, step.connectionId);
    }

    timer = setTimeout(() => controller.abort(new StepTimeoutError(timeoutMs)), timeoutMs);
    // Connectors should honour ctx.signal, but we never wait on one that doesn't.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(controller.signal.reason);
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener('abort', fail, { once: true });
    });

    const output = await Promise.race([
      action.run({
        input: valid.value,
        auth,
        http: deps.http.withSignal(controller.signal),
        logger,
        signal: controller.signal,
        workspaceId: inv.workspaceId,
        idempotencyKey: `${inv.runId}:${step.key}`,
        runId: inv.runId,
        stepKey: step.key,
        isTest: inv.isTest ?? false,
        sandbox: deps.sandbox,
      }),
      aborted,
    ]);
    return done({ ok: true, input, output: normalizeOutput(output) });
  } catch (err) {
    const failure = classifyError(err);
    if (failure.kind === 'auth' && step.connectionId) {
      await deps.credentials.markError(step.connectionId, failure.error.message, 'ERROR').catch(() => undefined);
    }
    return done({ ok: false, input, failure });
  } finally {
    if (timer) clearTimeout(timer);
    inv.signal?.removeEventListener('abort', onExternalAbort);
  }
}
