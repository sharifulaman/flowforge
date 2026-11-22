'use client';

import type { AppManifest } from '@flowforge/connector-sdk';
import type { StepDto } from '@flowforge/shared';
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getStraightPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertCircleIcon, CheckCircle2Icon, CircleDashedIcon, PlusIcon, ZapIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useMemo } from 'react';
import { AppIcon } from '@/components/apps/app-icon';
import { cn } from '@/lib/utils';
import { useBuilderActions } from './builder-context';
import { operationOf, setupProblems, type StepIssue } from './builder-utils';

const NODE_W = 320;
const NODE_H = 76;
const GAP = 64;

type StepNodeData = {
  step: StepDto | null; // null → empty trigger placeholder
  app?: AppManifest;
  index: number;
  selected: boolean;
  issues: StepIssue[];
};
type AddNodeData = { afterKey: string };

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const actions = useBuilderActions();
  const { step, app, index, selected, issues } = data;

  if (!step) {
    return (
      <button
        type="button"
        onClick={actions.chooseTrigger}
        className="flex h-[76px] w-[320px] items-center gap-3 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 px-4 text-left transition-colors hover:border-primary hover:bg-primary/10"
        data-testid="choose-trigger"
      >
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <ZapIcon className="size-4" />
        </span>
        <span>
          <span className="block text-sm font-semibold">1. Trigger</span>
          <span className="block text-xs text-muted-foreground">Choose the event that starts your Zap</span>
        </span>
        <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      </button>
    );
  }

  const op = operationOf(step, app);
  const problems = setupProblems(step, app);
  const status = issues.length ? 'error' : problems.length ? 'incomplete' : step.sampleAt ? 'tested' : 'ready';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => actions.select(step.id)}
      onKeyDown={(e) => e.key === 'Enter' && actions.select(step.id)}
      data-testid={`node-${step.key}`}
      className={cn(
        'group flex h-[76px] w-[320px] cursor-pointer items-center gap-3 rounded-xl border bg-card px-4 shadow-sm transition-all',
        'hover:-translate-y-px hover:shadow-md',
        selected ? 'border-primary ring-4 ring-primary/15' : 'hover:border-primary/40',
        status === 'error' && !selected && 'border-destructive/60',
      )}
    >
      {step.type === 'ACTION' && <Handle type="target" position={Position.Top} className="!opacity-0" />}
      <AppIcon app={app} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {index + 1}. {step.type === 'TRIGGER' ? 'Trigger' : 'Action'}
          <span className="font-mono normal-case opacity-70">· {step.key}</span>
        </div>
        <div className="truncate text-sm font-semibold">{step.name ?? op?.name ?? step.operationKey}</div>
        <div className="truncate text-xs text-muted-foreground">{app?.name ?? step.appKey}</div>
      </div>
      <span title={issues[0]?.message ?? problems[0] ?? (status === 'tested' ? 'Tested' : 'Ready')}>
        {status === 'error' && <AlertCircleIcon className="size-4 text-destructive" />}
        {status === 'incomplete' && <CircleDashedIcon className="size-4 text-warning" />}
        {status === 'tested' && <CheckCircle2Icon className="size-4 text-success" />}
        {status === 'ready' && <CheckCircle2Icon className="size-4 text-muted-foreground/50" />}
      </span>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function AddNode({ data }: NodeProps<Node<AddNodeData>>) {
  const actions = useBuilderActions();
  return (
    <div className="flex w-[320px] justify-center">
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <button
        type="button"
        onClick={() => actions.insertAfter(data.afterKey)}
        className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs font-medium shadow-sm transition-all hover:border-primary hover:text-primary hover:shadow-md"
        data-testid="add-step-end"
      >
        <PlusIcon className="size-3.5" /> Add step
      </button>
    </div>
  );
}

function InsertEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<{ afterKey: string; insertable: boolean }>>) {
  const actions = useBuilderActions();
  const [path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return (
    <>
      <BaseEdge id={id} path={path} style={{ strokeWidth: 1.5 }} className="!stroke-border" />
      {data?.insertable && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={() => actions.insertAfter(data.afterKey)}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="nodrag nopan pointer-events-auto absolute flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-all hover:scale-110 hover:border-primary hover:text-primary"
            aria-label={`Insert a step after ${data.afterKey}`}
            data-testid={`insert-after-${data.afterKey}`}
          >
            <PlusIcon className="size-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const noop = () => undefined;
const nodeTypes = { step: StepNode, add: AddNode };
const edgeTypes = { insert: InsertEdge };

/** Re-fit when steps are added/removed or the canvas is resized (e.g. the side panel opens). */
function FitOnChange({ count }: { count: number }) {
  const rf = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    const t = setTimeout(() => void rf.fitView({ padding: 0.3, maxZoom: 1, duration: 250 }), 50);
    return () => clearTimeout(t);
  }, [count, width, height, rf]);
  return null;
}

export function BuilderCanvas({
  steps,
  apps,
  selectedId,
  issues,
}: {
  steps: StepDto[];
  apps: Map<string, AppManifest>;
  selectedId: string | null;
  issues: Map<string, StepIssue[]>;
}) {
  const { resolvedTheme } = useTheme();
  const trigger = steps.find((s) => s.type === 'TRIGGER') ?? null;
  const actions = steps.filter((s) => s.type === 'ACTION');

  const { nodes, edges } = useMemo(() => {
    const ordered: Array<StepDto | null> = [trigger, ...actions];
    const nodes: Node[] = ordered.map((step, i) => ({
      id: step?.id ?? 'trigger-placeholder',
      type: 'step',
      position: { x: 0, y: i * (NODE_H + GAP) },
      data: { step, app: step ? apps.get(step.appKey) : undefined, index: i, selected: !!step && step.id === selectedId, issues: step ? (issues.get(step.key) ?? []) : [] } satisfies StepNodeData,
      draggable: false,
      width: NODE_W,
      height: NODE_H,
    }));
    const lastKey = actions.at(-1)?.key ?? 'trigger';
    nodes.push({ id: 'add', type: 'add', position: { x: 0, y: ordered.length * (NODE_H + GAP) - GAP / 2 + 4 }, data: { afterKey: lastKey } satisfies AddNodeData, draggable: false, selectable: false, width: NODE_W, height: 32 });

    const edges: Edge[] = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      edges.push({
        id: `e${i}`,
        source: nodes[i]!.id,
        target: nodes[i + 1]!.id,
        type: 'insert',
        data: { afterKey: ordered[i]?.key ?? 'trigger', insertable: !!trigger },
      });
    }
    if (trigger) edges.push({ id: 'e-add', source: nodes[ordered.length - 1]!.id, target: 'add', type: 'insert', data: { afterKey: lastKey, insertable: false } });
    return { nodes, edges };
  }, [trigger, actions, apps, selectedId, issues]);

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // React Flow disables pointer events on nodes that are neither selectable, draggable nor
        // have handlers. Our nodes handle clicks themselves, so register a handler to keep them live.
        onNodeClick={noop}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background gap={20} size={1.2} className="!bg-muted/30" />
        <Controls showInteractive={false} className="!rounded-lg !border !shadow-sm" />
        <FitOnChange count={nodes.length} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
