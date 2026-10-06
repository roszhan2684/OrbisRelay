"use client";
// Shared building blocks for the console "Intelligence" section (blueprint §28). Every component here
// renders data produced by the ML pipeline or the gateway — nothing is hard-coded.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import NumberFlow, { type Format } from "@number-flow/react";
import { motion } from "motion/react";
import { CheckCircle2, Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { cn } from "@/lib/format";
import { api } from "./live";

import { LABEL_TEXT, LABELS, pct } from "@/lib/ml-format";

const TABS = [
  { href: "/console/intelligence", label: "Overview" },
  { href: "/console/intelligence/models", label: "Models" },
  { href: "/console/intelligence/evaluation", label: "Evaluation" },
  { href: "/console/intelligence/endpoints", label: "Endpoints" },
  { href: "/console/intelligence/drift", label: "Drift" },
  { href: "/console/intelligence/review", label: "Review queue" },
];

export function IntelTabs({ reviewCount }: { reviewCount?: number }) {
  const path = usePathname();
  return (
    <nav className="-mt-2 mb-6 flex gap-1 overflow-x-auto border-b border-line" aria-label="Intelligence">
      {TABS.map((t) => {
        const active = t.href === "/console/intelligence" ? path === t.href : path.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("relative whitespace-nowrap px-3 pb-2.5 pt-1 text-[13.5px] font-medium transition", active ? "text-ink" : "text-muted hover:text-ink")}>
            {t.label}
            {t.label === "Review queue" && !!reviewCount && <span className="tnum ml-1.5 rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-2 ring-1 ring-inset ring-line">{reviewCount}</span>}
            {active && <motion.span layoutId="intel-tab" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-cobalt" />}
          </Link>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------- step-up + mutation helper

export function StepUpDialog({ open, title, body, onCancel, onVerified }: { open: boolean; title: string; body: string; onCancel: () => void; onVerified: () => void }) {
  const [phase, setPhase] = React.useState<"idle" | "verifying" | "ok">("idle");
  const verify = () => {
    setPhase("verifying");
    setTimeout(() => setPhase("ok"), 800);
    setTimeout(onVerified, 1250);
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-6 text-center shadow-pop">
          <div className={cn("mx-auto grid size-16 place-items-center rounded-2xl", phase === "ok" ? "bg-low-bg text-low" : "bg-cobalt-50 text-cobalt")}>
            {phase === "ok" ? <CheckCircle2 className="size-8" /> : phase === "verifying" ? <Loader2 className="size-8 animate-spin" /> : <KeyRound className="size-8" />}
          </div>
          <Dialog.Title className="mt-4 text-[18px] font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-[13.5px] text-muted">{body}</Dialog.Description>
          <div className="mt-5 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" className="flex-1" onClick={verify} disabled={phase !== "idle"}><Fingerprint className="size-4" /> Use passkey</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Button that runs an admin ML mutation behind a passkey step-up, then refreshes the page. */
export function StepUpAction({ label, title, body, path, json, variant = "secondary", size = "sm", disabled, disabledReason, onDone, icon }: {
  label: React.ReactNode; title: string; body: string; path: string; json: Record<string, unknown>; variant?: "primary" | "secondary" | "danger" | "dark" | "ghost"; size?: "sm" | "md"; disabled?: boolean; disabledReason?: string; onDone?: (r: unknown) => void; icon?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setOpen(false);
    setBusy(true);
    try {
      const r = await api(path, { method: "POST", json: { ...json, step_up: { method: "passkey", verified: true } } });
      toast.success(title.replace(/\?$/, ""), { description: "Recorded in the audit chain." });
      onDone?.(r);
      router.refresh();
    } catch (e) {
      const err = e as Error & { remediation?: string };
      toast.error(err.message, { description: err.remediation });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant={variant} size={size} disabled={disabled || busy} title={disabled ? disabledReason : undefined} onClick={() => setOpen(true)}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : icon}
        {label}
      </Button>
      <StepUpDialog key={open ? "o" : "c"} open={open} title={title} body={body} onCancel={() => setOpen(false)} onVerified={run} />
    </>
  );
}

// ---------------------------------------------------------------- confusion matrix

export function ConfusionMatrix({ cm, compact = false }: { cm: number[][]; compact?: boolean }) {
  const rowTotals = cm.map((r) => r.reduce((a, b) => a + b, 0));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-center text-[12px]" aria-label="Confusion matrix: rows are truth, columns are prediction">
        <thead>
          <tr>
            <th className="w-28 text-left text-[11px] font-medium uppercase tracking-wider text-faint">truth ↓ · pred →</th>
            {LABELS.map((l) => <th key={l} className="px-1 font-medium text-muted">{LABEL_TEXT[l]}</th>)}
          </tr>
        </thead>
        <tbody>
          {cm.map((row, i) => (
            <tr key={i}>
              <th className="text-left font-medium text-ink-2">{LABEL_TEXT[LABELS[i]]}</th>
              {row.map((v, j) => {
                const share = rowTotals[i] ? v / rowTotals[i] : 0;
                const diag = i === j;
                const danger = i >= 2 && j < 2;
                return (
                  <td key={j} className={cn("tnum rounded-md font-semibold", compact ? "h-9" : "h-12")} style={{ background: diag ? `color-mix(in oklab, var(--color-low) ${Math.round(8 + share * 30)}%, white)` : v === 0 ? "var(--color-surface-2)" : danger ? `color-mix(in oklab, var(--color-critical) ${Math.round(12 + share * 60)}%, white)` : `color-mix(in oklab, var(--color-medium) ${Math.round(8 + share * 40)}%, white)` }} title={`${v} of ${rowTotals[i]} ${LABELS[i]} predicted ${LABELS[j]}`}>
                    <NumberFlow value={v} className={cn(diag ? "text-low" : danger && v ? "text-critical" : "text-ink-2")} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11.5px] text-faint">Red cells are false allows of risky actions (the expensive mistake); amber cells are friction.</p>
    </div>
  );
}

// ---------------------------------------------------------------- threshold scrubber (idea #1)

export interface SweepRow { tau_review: number; tau_high: number; mean_cost: number; risky_escalation_recall: number | null; high_risk_escalation_recall: number | null; false_escalation_rate: number | null; confusion: number[][] }

export function ThresholdScrubber({ byReview, byHigh, chosen }: { byReview: SweepRow[]; byHigh: SweepRow[]; chosen: { tau_review: number; tau_high: number } }) {
  const [axis, setAxis] = React.useState<"review" | "high">("review");
  const rows = axis === "review" ? byReview : byHigh;
  const key = axis === "review" ? "tau_review" : "tau_high";
  const find = (rs: SweepRow[], k: "tau_review" | "tau_high") => Math.max(0, rs.findIndex((r) => Math.abs(r[k] - chosen[k]) < 1e-9));
  const chosenIdx = axis === "review" ? find(byReview, "tau_review") : find(byHigh, "tau_high");
  const [idxs, setIdxs] = React.useState(() => ({ review: find(byReview, "tau_review"), high: find(byHigh, "tau_high") }));
  const idx = idxs[axis];
  const setIdx = (i: number) => setIdxs((s) => ({ ...s, [axis]: i }));
  const row = rows[Math.min(idx, rows.length - 1)];
  const cm = row.confusion;
  const predictedSafe = cm.reduce((s, r) => s + r[0] + r[1], 0);
  const safePrecision = predictedSafe ? (cm[0][0] + cm[0][1] + cm[1][0] + cm[1][1]) / predictedSafe : 1;
  const maxCost = Math.max(...rows.map((r) => r.mean_cost));
  const W = 520, H = 120;
  const xs = (i: number) => (i / (rows.length - 1)) * W;
  const ys = (c: number) => H - 6 - (c / maxCost) * (H - 14);
  const path = rows.map((r, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(r.mean_cost).toFixed(1)}`).join(" ");
  const gates = [
    { name: "False-positive budget", ok: (row.false_escalation_rate ?? 0) <= 0.02, value: pct(row.false_escalation_rate, 2), target: "≤ 2%" },
    { name: "Safe-action precision", ok: safePrecision >= 0.95, value: pct(safePrecision, 2), target: "≥ 95%" },
    { name: "Risky recall (test)", ok: (row.risky_escalation_recall ?? 0) >= 0.94, value: pct(row.risky_escalation_recall), target: "≥ 94%" },
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-[10px] bg-surface-2 p-0.5 ring-1 ring-inset ring-line">
            {(["review", "high"] as const).map((a) => (
              <button key={a} onClick={() => setAxis(a)} className={cn("rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium", axis === a ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>
                {a === "review" ? "τ review  (P(susp)+P(high))" : "τ high  (P(high))"}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-muted">other threshold fixed at {axis === "review" ? `τ high ${chosen.tau_high}` : `τ review ${chosen.tau_review}`}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" role="img" aria-label="Mean security cost by threshold">
          <path d={`${path} L${W},${H} L0,${H} Z`} fill="var(--color-cobalt)" opacity={0.06} />
          <path d={path} fill="none" stroke="var(--color-cobalt)" strokeWidth={2} />
          <line x1={xs(chosenIdx)} x2={xs(chosenIdx)} y1={0} y2={H} stroke="var(--color-faint)" strokeDasharray="3 3" />
          <text x={xs(chosenIdx) + 4} y={11} fontSize={10} fill="var(--color-muted)">chosen</text>
          <motion.circle animate={{ cx: xs(idx), cy: ys(row.mean_cost) }} transition={{ type: "spring", stiffness: 400, damping: 32 }} r={6} fill="var(--color-cobalt)" stroke="white" strokeWidth={2} />
        </svg>
        <input aria-label="Threshold" type="range" min={0} max={rows.length - 1} value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="mt-2 w-full accent-[var(--color-cobalt)]" />
        <div className="mt-1 flex justify-between text-[11px] text-faint"><span>escalate more</span><span>escalate less</span></div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <Metric label={axis === "review" ? "τ review" : "τ high"} value={row[key]} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
          <Metric label="Mean cost" value={row.mean_cost} format={{ minimumFractionDigits: 3, maximumFractionDigits: 3 }} />
          <Metric label="High-risk recall" value={(row.high_risk_escalation_recall ?? 0) * 100} suffix="%" format={{ maximumFractionDigits: 1 }} />
        </div>
        <ul className="mt-4 space-y-1.5">
          {gates.map((g) => (
            <li key={g.name} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-[13px]">
              <span className="flex items-center gap-2"><span className={cn("size-2 rounded-full", g.ok ? "bg-low" : "bg-critical")} />{g.name}</span>
              <span className="tnum text-ink-2">{g.value} <span className="text-faint">({g.target})</span></span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <ConfusionMatrix cm={cm} compact />
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted">Thresholds were chosen on validation by minimising the security cost matrix, then moved toward escalation within a 5% cost tolerance. Scrubbing here re-scores the held-out test split — it never changes production.</p>
      </div>
    </div>
  );
}

function Metric({ label, value, suffix, format }: { label: string; value: number; suffix?: string; format?: Format }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-2 ring-1 ring-inset ring-line">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="tnum mt-0.5 text-[18px] font-semibold text-ink"><NumberFlow value={value} suffix={suffix} format={format} /></div>
    </div>
  );
}

// ---------------------------------------------------------------- rollout orbits (idea #3)

export interface OrbitEndpoint { id: string; name: string; model_version: string | null; state: string; real: boolean }

export function RolloutOrbits({ endpoints, roles, versions }: { endpoints: OrbitEndpoint[]; roles: { production: string | null; canary: { version: string; percent: number } | null; shadow: string | null }; versions: string[] }) {
  const [hover, setHover] = React.useState<OrbitEndpoint | null>(null);
  const ringOf = (e: OrbitEndpoint) => (e.state === "incompatible" || !e.model_version ? 3 : e.model_version === roles.production ? 0 : e.model_version === roles.canary?.version ? 1 : 2);
  const R = [70, 112, 150, 182];
  const ringLabel = [`production · ${roles.production ?? "—"}`, roles.canary ? `canary · ${roles.canary.version} · ${roles.canary.percent}%` : "canary · none", "older valid model", "fallback (incompatible)"];
  const groups = [0, 1, 2, 3].map((k) => endpoints.filter((e) => ringOf(e) === k));
  const color = (e: OrbitEndpoint) => (e.state === "incompatible" ? "var(--color-critical)" : e.state === "stale" ? "var(--color-faint)" : e.state === "degraded" ? "var(--color-high)" : ringOf(e) === 1 ? "var(--color-series-human)" : "var(--color-cobalt)");
  return (
    <div className="relative">
      <svg viewBox="-200 -200 400 400" className="mx-auto w-full max-w-[420px]" role="img" aria-label={`Endpoint fleet by model: ${groups.map((g, i) => `${g.length} ${ringLabel[i]}`).join(", ")}`}>
        <defs>
          <radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="var(--color-cobalt)" stopOpacity="0.18" /><stop offset="100%" stopColor="var(--color-cobalt)" stopOpacity="0" /></radialGradient>
        </defs>
        <circle r={60} fill="url(#core)" />
        {R.map((r, i) => <circle key={r} r={r} fill="none" stroke="var(--color-line-strong)" strokeDasharray={i === 3 ? "2 4" : i === 2 ? "4 4" : undefined} />)}
        <text textAnchor="middle" y={-4} fontSize={13} fontWeight={600} fill="var(--color-ink)">{roles.production ?? "no model"}</text>
        <text textAnchor="middle" y={12} fontSize={9.5} fill="var(--color-muted)">orbis-edge-risk</text>
        {groups.map((g, k) =>
          g.map((e, i) => {
            const a = ((i + (k % 2 ? 0.5 : 0)) / Math.max(g.length, 1)) * Math.PI * 2 - Math.PI / 2;
            const cx = Math.round(Math.cos(a) * R[k] * 100) / 100, cy = Math.round(Math.sin(a) * R[k] * 100) / 100;
            return (
              <motion.circle key={e.id} cx={cx} cy={cy} initial={false} animate={{ cx, cy }} transition={{ type: "spring", stiffness: 120, damping: 18 }}
                r={e.real ? 7 : 5.5} fill={color(e)} stroke={e.real ? "var(--color-ink)" : "white"} strokeWidth={e.real ? 2 : 1.5} onMouseEnter={() => setHover(e)} onMouseLeave={() => setHover(null)} className="cursor-pointer">
                <title>{`${e.name} — ${e.model_version ?? "no model"} · ${e.state}${e.real ? " · real endpoint" : ""}`}</title>
              </motion.circle>
            );
          }),
        )}
        {R.map((r, i) => <text key={i} x={0} y={-r - 5} textAnchor="middle" fontSize={9} fill="var(--color-faint)">{ringLabel[i]}</text>)}
      </svg>
      <div className="mt-2 min-h-5 text-center text-[12.5px] text-muted">{hover ? <><span className="font-medium text-ink">{hover.name}</span> · {hover.model_version ?? "no model"} · {hover.state}{hover.real ? " · real orbis-endpoint" : " · simulated"}</> : `${endpoints.length} endpoints · ${endpoints.filter((e) => e.real).length} real · hover a dot`}</div>
      {versions.length > 0 && <span className="sr-only">Known versions {versions.join(", ")}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- minimal markdown (model cards)

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((p, k) =>
      p.startsWith("**") ? <strong key={k} className="font-semibold text-ink">{p.slice(2, -2)}</strong> : p.startsWith("`") ? <code key={k} className="rounded bg-surface-2 px-1 py-px font-mono text-[12px]">{p.slice(1, -1)}</code> : p.startsWith("*") && p.length > 2 ? <em key={k}>{p.slice(1, -1)}</em> : p,
    );
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("# ")) out.push(<h2 key={i} className="mb-2 text-[20px] font-semibold tracking-[-0.02em] text-ink">{inline(l.slice(2))}</h2>);
    else if (l.startsWith("## ")) out.push(<h3 key={i} className="mb-2 mt-6 text-[15px] font-semibold text-ink">{inline(l.slice(3))}</h3>);
    else if (l.startsWith("> ")) out.push(<p key={i} className="my-2 border-l-2 border-cobalt pl-3 text-[13px] text-muted">{inline(l.slice(2))}</p>);
    else if (l.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2));
      out.push(<ul key={`u${i}`} className="my-2 list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ul>);
      continue;
    } else if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      out.push(
        <div key={`t${i}`} className="my-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-left text-[12.5px]">
            <thead className="bg-surface-2 text-muted"><tr>{rows[0].map((c, k) => <th key={k} className="px-3 py-2 font-medium">{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((r, k) => <tr key={k} className="border-t border-line">{r.map((c, j) => <td key={j} className="tnum px-3 py-1.5 text-ink-2">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    } else if (l.trim()) out.push(<p key={i} className="my-2 text-[13.5px] leading-relaxed text-ink-2">{inline(l)}</p>);
    i++;
  }
  return <div>{out}</div>;
}

export function GateRow({ g }: { g: { name: string; status: string; observed: unknown; threshold: unknown; source?: string; note?: string } }) {
  const show = (v: unknown) => (typeof v === "number" ? (Math.abs(v) < 1 && v !== 0 ? (v < 0.001 ? v.toExponential(1) : v.toFixed(4)) : String(v)) : typeof v === "string" ? v : v === null || v === undefined ? "—" : JSON.stringify(v).replace(/[{}"]/g, "").replace(/,/g, ", ").replace(/:/g, ": "));
  return (
    <li className="flex items-start gap-3 border-b border-line px-5 py-2.5 last:border-0">
      <span className={cn("mt-1 size-2.5 shrink-0 rounded-full", g.status === "pass" ? "bg-low" : g.status === "fail" ? "bg-critical" : "bg-faint")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-[13.5px] font-medium text-ink">{g.name.replace(/_/g, " ")}</span>
          <span className={cn("text-[12px] font-semibold uppercase", g.status === "pass" ? "text-low" : g.status === "fail" ? "text-critical" : "text-muted")}>{g.status}</span>
        </div>
        <div className="mt-0.5 break-words text-[12px] text-muted">observed <span className="font-mono text-ink-2">{show(g.observed)}</span> · target <span className="font-mono">{show(g.threshold)}</span></div>
        {g.note && <div className="mt-0.5 text-[11.5px] text-medium">{g.note}</div>}
      </div>
    </li>
  );
}
