"use client";
import NumberFlow, { type Format } from "@number-flow/react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Sparkline } from "@/components/charts";
import { cn } from "@/lib/format";

/** Stat tile contract: label · value · optional delta vs named period · optional 12-pt trend. */
export function StatTile({
  label,
  value,
  format,
  suffix,
  prefix,
  delta,
  deltaGood = "up",
  trend,
  hint,
}: {
  label: string;
  value: number;
  format?: Format;
  suffix?: string;
  prefix?: string;
  delta?: { value: number; label: string } | null;
  deltaGood?: "up" | "down";
  trend?: number[];
  hint?: string;
}) {
  const up = (delta?.value ?? 0) >= 0;
  const good = deltaGood === "up" ? up : !up;
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3.5 shadow-card">
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="text-[28px] font-semibold leading-none tracking-[-0.03em] text-ink">
          <NumberFlow value={value} format={format} prefix={prefix} suffix={suffix} />
        </div>
        {trend && <Sparkline values={trend} width={84} height={30} />}
      </div>
      <div className="mt-2 flex min-h-4 items-center gap-1.5 text-[12px]">
        {delta && (
          <span className={cn("inline-flex items-center gap-0.5 font-semibold", good ? "text-low" : "text-critical")}>
            {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
            {Math.abs(delta.value).toLocaleString("en-US", { maximumFractionDigits: 1 })}%
          </span>
        )}
        <span className="truncate text-muted">{delta ? delta.label : hint}</span>
      </div>
    </div>
  );
}
