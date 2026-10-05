"use client";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDot, Clock3, Hourglass, Pencil, ShieldAlert, ShieldCheck, Snowflake, XCircle, Ban, Eye } from "lucide-react";
import { cn, STATUS_LABEL } from "@/lib/format";

// ---------------------------------------------------------------- Button
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dark" | "outline-light";
export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg"; asChild?: boolean }
>(function Button({ className, variant = "secondary", size = "md", asChild, ...props }, ref) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium transition-[background,box-shadow,color,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-5 text-[15px]",
        variant === "primary" && "bg-cobalt text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(16,24,40,0.2)] hover:bg-cobalt-600",
        variant === "secondary" && "border border-line-strong bg-surface text-ink shadow-card hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "bg-critical text-white hover:bg-[#9a1d14]",
        variant === "dark" && "bg-ink text-white hover:bg-ink-2",
        variant === "outline-light" && "border border-white/20 bg-white/5 text-white hover:bg-white/10",
        className,
      )}
      {...props}
    />
  );
});

// ---------------------------------------------------------------- Card
export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius-card)] border border-line bg-surface shadow-card", className)} {...p} />;
}
export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-line px-5 py-4", className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- Badges
export function Badge({ className, tone = "neutral", children, ...p }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "cobalt" | "low" | "medium" | "high" | "critical" | "dark" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium leading-4",
        tone === "neutral" && "bg-surface-2 text-ink-2 ring-1 ring-inset ring-line",
        tone === "cobalt" && "bg-cobalt-50 text-cobalt-700 ring-1 ring-inset ring-cobalt-100",
        tone === "low" && "bg-low-bg text-low",
        tone === "medium" && "bg-medium-bg text-medium",
        tone === "high" && "bg-high-bg text-high",
        tone === "critical" && "bg-critical-bg text-critical",
        tone === "dark" && "bg-ink text-white",
        className,
      )}
      {...p}
    >
      {children}
    </span>
  );
}

const RISK_ICON = { low: ShieldCheck, medium: AlertTriangle, high: ShieldAlert, critical: AlertOctagon } as const;
/** Risk is always icon + label (+ optional score) — never color alone. */
export function RiskBadge({ level, score, className }: { level: "low" | "medium" | "high" | "critical" | string; score?: number; className?: string }) {
  const lv = (["low", "medium", "high", "critical"].includes(level) ? level : "medium") as keyof typeof RISK_ICON;
  const Icon = RISK_ICON[lv];
  return (
    <Badge tone={lv} className={cn("risk-badge", className)} aria-label={`${lv} risk${score !== undefined ? `, score ${score}` : ""}`}>
      <Icon className="size-3.5" aria-hidden />
      <span className="capitalize">{lv}</span>
      {score !== undefined && <span className="tnum opacity-75">· {score}</span>}
    </Badge>
  );
}

const STATUS_META: Record<string, { icon: React.ComponentType<{ className?: string }>; tone: React.ComponentProps<typeof Badge>["tone"] }> = {
  allow: { icon: CheckCircle2, tone: "low" },
  warn: { icon: AlertTriangle, tone: "medium" },
  deny: { icon: Ban, tone: "critical" },
  pending: { icon: Hourglass, tone: "cobalt" },
  approval_required: { icon: Hourglass, tone: "cobalt" },
  approved: { icon: CheckCircle2, tone: "low" },
  approved_modified: { icon: Pencil, tone: "low" },
  rejected: { icon: XCircle, tone: "critical" },
  expired: { icon: Clock3, tone: "neutral" },
  cancelled: { icon: CircleDot, tone: "neutral" },
  frozen: { icon: Snowflake, tone: "critical" },
  observe: { icon: Eye, tone: "neutral" },
};
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.cancelled;
  const Icon = m.icon;
  return (
    <Badge tone={m.tone} className={className}>
      <Icon className="size-3.5" aria-hidden />
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

// ---------------------------------------------------------------- Tooltip
export function Tip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Provider delayDuration={120}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-lg bg-ink px-2.5 py-1.5 text-[12px] leading-snug text-white shadow-pop">
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

// ---------------------------------------------------------------- misc
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>;
}

export function Avatar({ name, color, size = 28, className }: { name: string; color?: string; size?: number; className?: string }) {
  const initials = name.split(/[\s.]+/).map((p) => p[0]?.toUpperCase()).slice(0, 2).join("");
  return (
    <span className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold text-white", className)} style={{ width: size, height: size, fontSize: size * 0.38, background: color ?? "#5d6b82" }} aria-hidden>
      {initials}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: React.ComponentType<{ className?: string }>; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-cobalt-50 text-cobalt">
        <Icon className="size-6" />
      </div>
      <h4 className="mt-4 text-[15px] font-semibold">{title}</h4>
      <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "h-10 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-sm text-ink shadow-card outline-none placeholder:text-faint focus:border-cobalt focus:ring-4 focus:ring-cobalt-100";

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: React.ReactNode }>; className?: string }) {
  return (
    <div role="tablist" className={cn("inline-flex max-w-full flex-wrap rounded-[10px] bg-surface-2 p-0.5 ring-1 ring-inset ring-line", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("rounded-[8px] px-3 py-1.5 text-[13px] font-medium transition", value === o.value ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[12px] text-ink-2", className)}>{children}</span>;
}
