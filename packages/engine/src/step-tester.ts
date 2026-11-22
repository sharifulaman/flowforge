import type { ConnectorRegistry } from '@flowforge/connector-sdk';
import { Prisma, type PrismaClient, type ZapStep } from '@flowforge/db';
import type { StepDefinition, TemplateScope, TestStepJobData, TestStepResult } from '@flowforge/shared';
import { randomUUID } from 'node:crypto';
import { classifyError } from './errors';
import { runActionStep, type StepRunnerDeps } from './step-runner';

export interface StepTesterDeps extends StepRunnerDeps {
  prisma: PrismaClient;
  registry: ConnectorRegistry;
}

const ordered = (steps: ZapStep[]) =>
  [...steps].sort((a, b) => (a.type === b.type ? a.position - b.position : a.type === 'TRIGGER' ? -1 : 1));

/**
 * "Test step" in the builder: runs one draft step for real, using the sample outputs of the
 * steps before it as template data. Successful outputs become the step's sample, which feeds
 * the field picker of later steps.
 */
export class StepTester {
  constructor(private readonly d: StepTesterDeps) {}

  async test(job: TestStepJobData): Promise<TestStepResult> {
    const started = Date.now();
    const zap = await this.d.prisma.zap.findFirst({
      where: { id: job.zapId, workspaceId: job.workspaceId, deletedAt: null },
      include: { steps: true },
    });
    const step = zap?.steps.find((s) => s.id === job.stepId);
    if (!zap || !step) return this.error('Step not found', 'NOT_FOUND', started);

    const steps = ordered(zap.steps);
    const scope: TemplateScope = {};
    for (const s of steps) {
      if (s.id === step.id) break;
      scope[s.key] = s.sampleOutput ?? this.exampleOutput(s) ?? {};
    }

    const result = step.type === 'TRIGGER' ? await this.testTrigger(step, zap.workspaceId) : await this.testAction(step, scope);
    if (result.status === 'success') {
      await this.d.prisma.zapStep.update({
        where: { id: step.id },
        data: { sampleOutput: (result.output ?? {}) as Prisma.InputJsonValue, sampleAt: new Date() },
      });
    }
    return { ...result, durationMs: Date.now() - started };
  }

  private exampleOutput(s: ZapStep): unknown {
    const op = s.type === 'TRIGGER' ? this.d.registry.getTrigger(s.appKey, s.operationKey) : this.d.registry.getAction(s.appKey, s.operationKey);
    return op?.sampleOutput;
  }

  private async testAction(step: ZapStep, scope: TemplateScope): Promise<TestStepResult> {
    const def: StepDefinition = {
      key: step.key,
      name: step.name,
      appKey: step.appKey,
      operationKey: step.operationKey,
      connectionId: step.connectionId,
      config: (step.config ?? {}) as Record<string, unknown>,
      timeoutMs: step.timeoutMs,
    };
    const r = await runActionStep(this.d, { workspaceId: step.workspaceId, runId: `test_${randomUUID()}`, step: def, scope, isTest: true });
    const logs = r.logs.map((l) => ({ level: l.level, message: l.message }));
    if (r.ok) return { status: 'success', input: r.input, output: r.output, error: null, logs, durationMs: r.durationMs };
    const f = r.failure;
    if (f.kind === 'stop') return { status: 'filtered', input: r.input, output: { stopped: true, reason: f.reason }, error: null, logs, durationMs: r.durationMs };
    if (f.kind === 'suspend') {
      // Don't actually wait in a test.
      return { status: 'success', input: r.input, output: { wouldResumeAt: f.resumeAt.toISOString() }, error: null, logs, durationMs: r.durationMs };
    }
    return { status: 'error', input: r.input, output: null, error: f.error, logs, durationMs: r.durationMs };
  }

  private async testTrigger(step: ZapStep, workspaceId: string): Promise<TestStepResult> {
    const trigger = this.d.registry.getTrigger(step.appKey, step.operationKey);
    if (!trigger) return this.error(`Unknown trigger ${step.appKey}.${step.operationKey}`, 'UNKNOWN_TRIGGER', Date.now());
    const ok = (output: unknown, logs: TestStepResult['logs'] = []): TestStepResult => ({ status: 'success', input: step.config, output, error: null, logs, durationMs: 0 });

    switch (trigger.kind) {
      case 'webhook':
        if (step.sampleOutput) return ok(step.sampleOutput);
        return this.error('No requests received yet. Send a request to the webhook URL, then test again.', 'NO_SAMPLE', Date.now());
      case 'schedule': {
        const now = new Date().toISOString();
        return ok({ firedAt: now, scheduledFor: now, timezone: (step.config as { timezone?: string }).timezone ?? 'UTC' });
      }
      case 'app_webhook':
        if (step.sampleOutput) return ok(step.sampleOutput);
        return ok(trigger.sampleOutput ?? {}, [{ level: 'info', message: 'Showing example data. Real events will appear here once the Zap receives one.' }]);
      case 'polling': {
        try {
          const auth = step.connectionId ? await this.d.credentials.getAuth(workspaceId, step.connectionId) : {};
          const signal = AbortSignal.timeout(30_000);
          const res = await trigger.poll({
            input: step.config as Record<string, unknown>,
            cursor: undefined,
            auth,
            http: this.d.http.withSignal(signal),
            logger: { debug() {}, info() {}, warn() {}, error() {} },
            signal,
            workspaceId,
            zapId: step.zapId,
          });
          const latest = res.items[res.items.length - 1];
          if (!latest) return this.error('No recent items found. Create one in the app, then test again.', 'NO_ITEMS', Date.now());
          return ok(latest.data, [{ level: 'info', message: `Found ${res.items.length} recent item(s); showing the newest.` }]);
        } catch (err) {
          const c = classifyError(err);
          return this.error('error' in c ? c.error.message : String(err), 'error' in c ? c.error.code : undefined, Date.now());
        }
      }
    }
  }

  private error(message: string, code: string | undefined, started: number): TestStepResult {
    return { status: 'error', input: null, output: null, error: { message, code }, logs: [], durationMs: Date.now() - started };
  }
}
