'use client';

import type { StatsBucket } from '@flowforge/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bucketLabel, compactNumber, labelEvery, niceScale } from '@/lib/chart';
import { cn } from '@/lib/utils';

/**
 * Stacked columns of runs per time bucket, by outcome.
 * Colors: categorical slots blue / orange / aqua (validated CVD-safe all-pairs in light and
 * dark). Aqua is < 3:1 on the light surface → the table view is always available.
 * Identity never relies on color alone: legend + tooltip + table.
 */
const SERIES = [
  { key: 'succeeded', label: 'Succeeded', color: 'var(--chart-succeeded)' },
  { key: 'failed', label: 'Failed', color: 'var(--chart-failed)' },
  { key: 'filtered', label: 'Filtered', color: 'var(--chart-filtered)' },
] as const;

const HEIGHT = 220;
const M = { top: 8, right: 8, bottom: 24, left: 40 };
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end

const TOOLTIP_W = 176;
function tooltipPosition(cx: number, colW: number, width: number): React.CSSProperties {
  const offset = colW / 2 + 10;
  const left = cx > width / 2 ? cx - offset - TOOLTIP_W : cx + offset;
  return { left: Math.max(0, Math.min(left, width - TOOLTIP_W)), width: TOOLTIP_W };
}

function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function RunsChart({ series, bucket }: { series: StatsBucket[]; bucket: 'hour' | 'day' }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const totals = series.map((b) => b.succeeded + b.failed + b.filtered);
  const scale = useMemo(() => niceScale(Math.max(0, ...totals)), [totals]);
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = HEIGHT - M.top - M.bottom;
  const band = series.length ? innerW / series.length : 0;
  const colW = Math.max(2, Math.min(24, band * 0.62));
  const y = (v: number) => (v / scale.max) * innerH;
  const every = labelEvery(series.length, Math.max(2, Math.floor(innerW / 64)));
  const sum = totals.reduce((a, b) => a + b, 0);
  const hovered = hover === null ? null : series[hover];

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
        <div className="flex rounded-md border p-0.5 text-xs" role="tablist" aria-label="Chart or table">
          {(['chart', 'table'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('rounded px-2 py-0.5 capitalize transition-colors', view === v ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === 'table' ? (
        <div className="max-h-[220px] overflow-auto rounded-lg border">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-medium">{bucket === 'hour' ? 'Hour (UTC)' : 'Day (UTC)'}</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="px-3 py-1.5 text-right font-medium">
                    {s.label}
                  </th>
                ))}
                <th className="px-3 py-1.5 text-right font-medium">Other</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {series.map((b) => (
                <tr key={b.start}>
                  <td className="px-3 py-1.5">{bucketLabel(b.start, bucket)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="px-3 py-1.5 text-right">
                      {b[s.key]}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right">{b.other}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="relative" onMouseLeave={() => setHover(null)}>
          {width > 0 && (
            <svg width={width} height={HEIGHT} role="img" aria-label={`Runs over time: ${sum} total. Use the table view for exact values.`} className="block overflow-visible">
              {/* Recessive hairline grid + baseline */}
              {scale.ticks.map((t) => (
                <g key={t} transform={`translate(0, ${M.top + innerH - y(t)})`}>
                  <line x1={M.left} x2={M.left + innerW} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={M.left - 8} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                    {compactNumber(t)}
                  </text>
                </g>
              ))}
              {series.map((b, i) => {
                const cx = M.left + band * i + band / 2;
                const x = cx - colW / 2;
                const visible = SERIES.filter((s) => b[s.key] > 0);
                let cursor = M.top + innerH; // baseline
                return (
                  <g key={b.start}>
                    {hover === i && <rect x={M.left + band * i} y={M.top} width={band} height={innerH} className="fill-muted" opacity={0.6} />}
                    {visible.map((s, j) => {
                      const h = y(b[s.key]);
                      const gap = j > 0 ? GAP : 0;
                      const top = cursor - h;
                      const segH = Math.max(1, h - gap);
                      cursor = top;
                      const isTop = j === visible.length - 1;
                      return isTop ? (
                        <path key={s.key} d={topRoundedRect(x, top, colW, segH, RADIUS)} fill={s.color} />
                      ) : (
                        <rect key={s.key} x={x} y={top} width={colW} height={segH} fill={s.color} />
                      );
                    })}
                    {i % every === 0 && (
                      <text x={cx} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                        {bucketLabel(b.start, bucket)}
                      </text>
                    )}
                    {/* Hit target: the whole band, larger than the mark. */}
                    <rect
                      x={M.left + band * i}
                      y={M.top}
                      width={band}
                      height={innerH}
                      fill="transparent"
                      tabIndex={0}
                      aria-label={`${bucketLabel(b.start, bucket)}: ${b.succeeded} succeeded, ${b.failed} failed, ${b.filtered} filtered`}
                      onMouseEnter={() => setHover(i)}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover(null)}
                      className="outline-none"
                    />
                  </g>
                );
              })}
              <line x1={M.left} x2={M.left + innerW} y1={M.top + innerH} y2={M.top + innerH} stroke="var(--muted-foreground)" strokeOpacity={0.35} strokeWidth={1} shapeRendering="crispEdges" />
            </svg>
          )}
          {hovered && hover !== null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-2 z-10 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg"
              // Open beside the hovered column (never on top of it): left of it in the right half.
              style={tooltipPosition(M.left + band * hover + band / 2, colW, width)}
            >
              <p className="mb-1 font-medium">{bucketLabel(hovered.start, bucket)}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-medium tabular-nums">{hovered[s.key]}</span>
                </p>
              ))}
              {hovered.other > 0 && (
                <p className="flex justify-between gap-4 text-muted-foreground">
                  <span>Other (canceled, in progress)</span>
                  <span className="tabular-nums">{hovered.other}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
