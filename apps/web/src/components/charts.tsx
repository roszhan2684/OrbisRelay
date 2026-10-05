"use client";
import * as React from "react";
import { cn, num, shortDate } from "@/lib/format";

// Chart primitives following the dataviz mark specs: ≤24px columns with 4px rounded data-ends,
// 2px surface gaps between stacked segments, hairline solid grid, hover tooltip, legend for ≥2
// series, and a table view so identity is never color-alone.

export interface Series {
  key: string;
  label: string;
  color: string;
}

export function Legend({ series, className }: { series: Series[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2", className)}>
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((c) => n <= c) ?? 10;
  return step * p;
}

export function StackedColumns<T extends { date: string } & Record<string, number | string>>({
  data,
  series,
  height = 220,
  label,
}: {
  data: T[];
  series: Series[];
  height?: number;
  label: string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const [table, setTable] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(640);
  React.useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const totals = data.map((d) => series.reduce((s, x) => s + Number(d[x.key] ?? 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const padL = 36;
  const padB = 22;
  const innerW = Math.max(100, w - padL);
  const innerH = height - padB - 8;
  const band = innerW / data.length;
  const barW = Math.min(24, band * 0.62);
  const ticks = [0, max / 2, max];
  const GAP = 2;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Legend series={series} />
        <button onClick={() => setTable((t) => !t)} className="text-[12px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline">
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-[260px] overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-surface-2 text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="px-3 py-2 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="tnum">
              {data.map((d) => (
                <tr key={d.date} className="border-t border-line">
                  <td className="px-3 py-1.5">{shortDate(d.date)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-3 py-1.5 text-right">{num(Number(d[s.key] ?? 0))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
          <svg width={w} height={height} role="img" aria-label={label}>
            {ticks.map((t) => {
              const y = 8 + innerH - (t / max) * innerH;
              return (
                <g key={t}>
                  <line x1={padL} x2={w} y1={y} y2={y} stroke="var(--color-grid)" strokeWidth={1} />
                  <text x={padL - 8} y={y + 4} textAnchor="end" className="tnum fill-[var(--color-faint)] text-[11px]">
                    {num(t, true)}
                  </text>
                </g>
              );
            })}
            {data.map((d, i) => {
              const cx = padL + band * i + band / 2;
              let y = 8 + innerH;
              const segs = series
                .map((s) => ({ s, v: Number(d[s.key] ?? 0) }))
                .filter((x) => x.v > 0);
              return (
                <g key={d.date} opacity={hover === null || hover === i ? 1 : 0.45}>
                  {segs.map(({ s, v }, si) => {
                    const h = Math.max(1, (v / max) * innerH - (si > 0 ? GAP : 0));
                    y -= h + (si > 0 ? GAP : 0);
                    const top = si === segs.length - 1;
                    const r = top ? Math.min(4, h) : 0;
                    const x = cx - barW / 2;
                    const path = top
                      ? `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${y + h} Z`
                      : `M${x},${y} h${barW} v${h} h${-barW} Z`;
                    return <path key={s.key} d={path} fill={s.color} />;
                  })}
                  {(i % Math.ceil(data.length / 7) === 0 || i === data.length - 1) && (
                    <text x={cx} y={height - 4} textAnchor="middle" className="fill-[var(--color-faint)] text-[11px]">
                      {shortDate(d.date)}
                    </text>
                  )}
                  <rect x={padL + band * i} y={0} width={band} height={height - padB} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] shadow-pop"
              style={{ left: Math.min(Math.max(0, padL + band * hover + band / 2 - 80), w - 170) }}
            >
              <div className="mb-1 font-semibold text-ink">{shortDate(data[hover].date)}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="tnum font-medium text-ink">{num(Number(data[hover][s.key] ?? 0))}</span>
                </div>
              ))}
              <div className="mt-1 flex justify-between border-t border-line pt-1 text-muted">
                <span>Total</span>
                <span className="tnum">{num(totals[hover])}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for ranked magnitudes (single series → no legend). */
export function HBars({ rows, color = "var(--color-series-auto)", suffix = "" }: { rows: Array<{ label: React.ReactNode; value: number; sub?: React.ReactNode; color?: string; key: string }>; color?: string; suffix?: string }) {
  const format = (n: number) => `${num(n)}${suffix}`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
              <span className="truncate">{r.label}</span>
              {r.sub && <span className="truncate text-[12px] text-faint">{r.sub}</span>}
            </span>
            <span className="tnum shrink-0 font-medium text-ink">{format(r.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-surface-2" title={`${typeof r.label === "string" ? r.label : r.key}: ${format(r.value)}`}>
            <div className="h-2 rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: r.color ?? color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 12–48 point sparkline in a de-emphasis hue with the current point in the accent. */
export function Sparkline({ values, width = 120, height = 28, accent = "var(--color-cobalt)", className, label }: { values: number[]; width?: number; height?: number; accent?: string; className?: string; label?: string }) {
  const max = Math.max(...values, 1);
  const step = width / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className={className} role="img" aria-label={label ?? `trend, latest ${values[values.length - 1]}`}>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={accent} opacity={0.08} />
      <path d={d} fill="none" stroke="var(--color-faint)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={3.5} fill={accent} stroke="var(--color-surface)" strokeWidth={2} />}
    </svg>
  );
}

/** Meter: severity fill on a lighter track of the same ramp. */
export function Meter({ value, max = 100, tone = "cobalt" }: { value: number; max?: number; tone?: "cobalt" | "low" | "medium" | "high" | "critical" }) {
  const fill = { cobalt: "var(--color-cobalt)", low: "var(--color-low)", medium: "#d18f00", high: "var(--color-high)", critical: "var(--color-critical)" }[tone];
  const track = { cobalt: "var(--color-cobalt-50)", low: "var(--color-low-bg)", medium: "var(--color-medium-bg)", high: "var(--color-high-bg)", critical: "var(--color-critical-bg)" }[tone];
  return (
    <div className="h-1.5 w-full rounded-full" style={{ background: track }} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: fill }} />
    </div>
  );
}
