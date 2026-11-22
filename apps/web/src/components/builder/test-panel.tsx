'use client';

import type { StepDto, TestStepResult } from '@flowforge/shared';
import { AlertCircleIcon, CheckCircle2Icon, FilterIcon, FlaskConicalIcon } from 'lucide-react';
import { JsonView } from '@/components/common/json-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTestStep } from '@/hooks/use-builder';
import { ApiError } from '@/lib/api-client';
import { formatDuration, relativeTime } from '@/lib/time';

export function TestPanel({ ws, zapId, step, hookUrl, disabledReason }: { ws: string; zapId: string; step: StepDto; hookUrl: string | null; disabledReason?: string }) {
  const test = useTestStep(ws, zapId);
  const result: TestStepResult | undefined = test.data;
  const isWebhook = step.type === 'TRIGGER' && step.appKey === 'webhook';

  return (
    <div className="grid gap-4">
      {isWebhook && hookUrl && (
        <div className="grid gap-2 text-sm">
          <p className="text-muted-foreground">Send a test request, then load it:</p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">{`curl -X POST '${hookUrl}' \\\n  -H 'content-type: application/json' \\\n  -d '{"email":"jane@example.com","plan":"pro"}'`}</pre>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={() => test.mutate(step.id)} disabled={test.isPending || !!disabledReason} data-testid="test-step">
          {test.isPending ? <Spinner /> : <FlaskConicalIcon />}
          {test.isPending ? 'Testing…' : isWebhook ? 'Load latest request' : 'Test step'}
        </Button>
        {disabledReason && <span className="text-xs text-muted-foreground">{disabledReason}</span>}
      </div>

      {test.error && (
        <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          {test.error instanceof ApiError ? test.error.message : 'Test failed'}
        </div>
      )}

      {result && (
        <div className="grid gap-3 animate-in fade-in-0 slide-in-from-bottom-1" data-testid="test-result">
          <div className="flex items-center gap-2">
            {result.status === 'success' && (
              <Badge variant="success">
                <CheckCircle2Icon /> Success
              </Badge>
            )}
            {result.status === 'error' && (
              <Badge variant="destructive">
                <AlertCircleIcon /> Failed
              </Badge>
            )}
            {result.status === 'filtered' && (
              <Badge variant="warning">
                <FilterIcon /> Would stop here
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{formatDuration(result.durationMs)}</span>
          </div>
          {result.error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{result.error.message}</p>}
          {result.input !== null && result.input !== undefined && step.type === 'ACTION' && (
            <section className="grid gap-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">Data sent</h4>
              <JsonView value={result.input} maxHeight="max-h-48" />
            </section>
          )}
          {result.output !== null && result.output !== undefined && (
            <section className="grid gap-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">Output {result.status === 'success' && '(saved as sample data)'}</h4>
              <JsonView value={result.output} />
            </section>
          )}
          {result.logs.length > 0 && (
            <section className="grid gap-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">Logs</h4>
              <div className="rounded-lg border bg-muted/40 p-2 font-mono text-xs">
                {result.logs.map((l, i) => (
                  <div key={i} className={l.level === 'error' ? 'text-destructive' : l.level === 'warn' ? 'text-warning' : undefined}>
                    <span className="opacity-60">[{l.level}]</span> {l.message}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {!result && step.sampleOutput !== null && step.sampleOutput !== undefined && (
        <section className="grid gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Current sample · {relativeTime(step.sampleAt)}</h4>
          <JsonView value={step.sampleOutput} />
        </section>
      )}
    </div>
  );
}
