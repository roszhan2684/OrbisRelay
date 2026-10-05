"use client";
import * as React from "react";
import { motion, AnimatePresence } from "motion/react";
import { AlertOctagon, AlertTriangle, ArrowRight, Bot, Building2, CheckCircle2, ChevronLeft, ChevronRight, Cpu, FileText, Pencil, ScanFace, Shield, ShieldAlert, ShieldCheck, Sparkles, User, Workflow, X, Zap, BatteryFull, Wifi, Signal, Inbox as InboxIcon, Activity as ActivityIcon, ScanSearch, OctagonPause, CircleUser } from "lucide-react";
import type { ApprovalRecord } from "@/lib/domain";
import { cn, ROUTE_LABEL, until } from "@/lib/format";

export type PhoneApproval = Pick<
  ApprovalRecord,
  "id" | "title" | "summary" | "intent" | "route" | "status" | "step_up" | "quorum" | "created_at" | "expires_at" | "editable_fields" | "safe_alternatives" | "evidence" | "blast_radius" | "risk" | "policy" | "actor" | "integration" | "parameters" | "escalation_level"
> & { quorum_progress?: { approvals: number; required: number } | null; can_respond?: boolean };

export function PhoneFrame({ children, className, dark }: { children: React.ReactNode; className?: string; dark?: boolean }) {
  return (
    <div className={cn("relative mx-auto w-[340px] shrink-0 rounded-[54px] bg-[#0a0a0c] p-[11px] shadow-[0_30px_80px_-20px_rgba(7,11,23,0.55),inset_0_0_0_1.5px_rgba(255,255,255,0.09)]", className)}>
      <div className={cn("relative h-[700px] overflow-hidden rounded-[44px]", dark ? "bg-[#0b0f1a] text-white" : "bg-[#f2f2f7] text-ink")}>
        <div className="absolute left-1/2 top-[10px] z-30 h-[30px] w-[104px] -translate-x-1/2 rounded-full bg-black" aria-hidden />
        <div className={cn("relative z-20 flex h-[50px] items-center justify-between px-8 pt-1 text-[14px] font-semibold", dark ? "text-white" : "text-ink")}>
          <span className="tnum">9:41</span>
          <span className="flex items-center gap-1">
            <Signal className="size-3.5" />
            <Wifi className="size-3.5" />
            <BatteryFull className="size-[18px]" />
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 top-[50px] overflow-hidden">{children}</div>
        <div className={cn("absolute bottom-[7px] left-1/2 z-30 h-[5px] w-[120px] -translate-x-1/2 rounded-full", dark ? "bg-white/70" : "bg-black/80")} aria-hidden />
      </div>
    </div>
  );
}

const ACTOR_ICON = { agent: Bot, workflow: Workflow, automation: Zap, service: Cpu, human: User } as const;
const RISK = {
  low: { icon: ShieldCheck, cls: "text-low bg-low-bg", label: "Low risk" },
  medium: { icon: AlertTriangle, cls: "text-medium bg-medium-bg", label: "Medium risk" },
  high: { icon: ShieldAlert, cls: "text-high bg-high-bg", label: "High risk" },
  critical: { icon: AlertOctagon, cls: "text-critical bg-critical-bg", label: "Critical risk" },
} as const;

export function RiskPill({ level, score }: { level: string; score?: number }) {
  const r = RISK[(level as keyof typeof RISK) ?? "medium"] ?? RISK.medium;
  const Icon = r.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold", r.cls)}>
      <Icon className="size-3.5" aria-hidden /> {r.label}
      {score !== undefined && <span className="tnum font-medium opacity-70">{score}</span>}
    </span>
  );
}

export function InboxRow({ a, onOpen, now }: { a: PhoneApproval; onOpen: () => void; now: number }) {
  const Icon = ACTOR_ICON[a.actor.type as keyof typeof ACTOR_ICON] ?? Bot;
  const mins = (new Date(a.expires_at).getTime() - now) / 60000;
  return (
    <button onClick={onOpen} className="flex w-full items-start gap-3 rounded-2xl bg-white px-3.5 py-3 text-left shadow-[0_1px_0_rgba(0,0,0,0.04)] transition active:scale-[0.99]">
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-[#eef1fe] text-cobalt">
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{a.title}</span>
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-[#6b7280]">
          {a.actor.name} · {a.integration.name}
        </span>
        <span className="mt-1.5 flex items-center gap-2">
          <RiskPill level={a.risk.level} />
          <span className={cn("tnum text-[12px] font-medium", mins < 15 ? "text-critical" : "text-[#6b7280]")}>{until(a.expires_at, now)}</span>
          {a.quorum && <span className="text-[12px] text-[#6b7280]">{a.quorum_progress?.approvals ?? 0}/{a.quorum.required} signed</span>}
        </span>
      </span>
      <ChevronRight className="mt-2 size-4 shrink-0 text-[#c7c7cc]" />
    </button>
  );
}

export type ResponsePayload =
  | { decision: "approve" }
  | { decision: "reject"; comment?: string }
  | { decision: "approve_modified"; modified_parameters: Record<string, number> }
  | { decision: "safe_alternative"; alternative_id: string };

/** Approval detail — WHAT / WHO / WHY / RISK / POLICY / EVIDENCE / BLAST RADIUS / SAFE ALTERNATIVE. */
export function PhoneApprovalDetail({
  a,
  onBack,
  onRespond,
  now,
  busy,
  result,
}: {
  a: PhoneApproval;
  onBack?: () => void;
  onRespond: (p: ResponsePayload) => Promise<void> | void;
  now: number;
  busy?: boolean;
  result?: { status: string; receipt_id?: string | null; message?: string } | null;
}) {
  const [mode, setMode] = React.useState<"view" | "edit" | "reject">("view");
  const [edits, setEdits] = React.useState<Record<string, number>>({});
  const [faceId, setFaceId] = React.useState<null | ResponsePayload>(null);
  const [showEvidence, setShowEvidence] = React.useState(true);
  const Icon = ACTOR_ICON[a.actor.type as keyof typeof ACTOR_ICON] ?? Bot;

  const submit = (p: ResponsePayload) => {
    if (p.decision !== "reject" && a.step_up === "biometric") setFaceId(p);
    else void onRespond(p);
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2">
        {onBack ? (
          <button onClick={onBack} className="-ml-1 flex items-center text-[16px] text-cobalt">
            <ChevronLeft className="size-5" /> Inbox
          </button>
        ) : (
          <span className="text-[13px] font-semibold uppercase tracking-wide text-cobalt">Action paused</span>
        )}
        <span className="tnum text-[13px] text-[#6b7280]">Expires in {until(a.expires_at, now)}</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-40">
        <div className="rounded-[22px] bg-white p-4">
          <div className="flex items-center gap-2 text-[12.5px] text-[#6b7280]">
            <span className="grid size-6 place-items-center rounded-lg bg-[#eef1fe] text-cobalt">
              <Icon className="size-3.5" />
            </span>
            <span className="truncate">
              {a.actor.name} · <span className="capitalize">{a.actor.type}</span> via {a.integration.name}
            </span>
          </div>
          <h2 className="mt-2.5 text-[23px] font-semibold leading-[1.15] tracking-[-0.025em]">{a.title}</h2>
          {a.intent && <p className="mt-1.5 text-[14px] leading-snug text-[#3c3c43]">“{a.intent}”</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <RiskPill level={a.risk.level} score={a.risk.score} />
            {a.step_up === "biometric" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#f2f2f7] px-2 py-0.5 text-[12px] font-medium text-[#3c3c43]">
                <ScanFace className="size-3.5" /> Face ID required
              </span>
            )}
            {a.quorum && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#f2f2f7] px-2 py-0.5 text-[12px] font-medium text-[#3c3c43]">
                {a.quorum_progress?.approvals ?? 0} of {a.quorum.required} approvals
              </span>
            )}
          </div>
          {a.risk.reasons.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {a.risk.reasons
                .filter((r) => r.weight > 0)
                .slice(0, 3)
                .map((r) => (
                  <li key={r.code} className="flex items-start gap-2 text-[13px] text-[#3c3c43]">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-high" /> {r.label}
                  </li>
                ))}
            </ul>
          )}
        </div>

        <div className="rounded-[22px] bg-white p-4">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-[#6b7280]">
            <Shield className="size-3.5" /> Why Orbis paused this
          </div>
          <p className="mt-1.5 text-[14px] leading-snug">{a.policy.reason}</p>
          <p className="mt-2 font-mono text-[11px] text-[#6b7280]">
            {a.policy.name} · v{a.policy.version} · {a.policy.rule_id}
          </p>
          <p className="mt-1 text-[12px] text-[#6b7280]">Routed to {ROUTE_LABEL[a.route] ?? a.route}</p>
        </div>

        {a.evidence.length > 0 && (
          <div className="rounded-[22px] bg-white">
            <button className="flex w-full items-center justify-between px-4 py-3 text-[12px] font-semibold uppercase tracking-wide text-[#6b7280]" onClick={() => setShowEvidence((s) => !s)} aria-expanded={showEvidence}>
              <span className="flex items-center gap-1.5">
                <FileText className="size-3.5" /> Evidence · {a.evidence.length}
              </span>
              <ChevronRight className={cn("size-4 transition", showEvidence && "rotate-90")} />
            </button>
            {showEvidence && (
              <ul className="divide-y divide-[#f2f2f7] border-t border-[#f2f2f7]">
                {a.evidence.map((e) => (
                  <li key={e.id} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-semibold">{e.label}</span>
                      <span className="shrink-0 text-[11px] text-[#8e8e93]">{e.source}</span>
                    </div>
                    <p className="mt-0.5 text-[13px] leading-snug text-[#3c3c43]">{e.value}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {a.blast_radius.length > 0 && (
          <div className="rounded-[22px] bg-white p-4">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-[#6b7280]">If approved</div>
            <ul className="mt-2 space-y-1.5">
              {a.blast_radius.map((b) => (
                <li key={b} className="flex gap-2 text-[13px] leading-snug">
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-high" /> {b}
                </li>
              ))}
            </ul>
          </div>
        )}

        {mode === "edit" && a.editable_fields.length > 0 && (
          <div className="rounded-[22px] bg-white p-4">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-[#6b7280]">Edit & approve</div>
            {a.editable_fields.map((f) => {
              const cur = edits[f.key] ?? Number(a.parameters[f.key] ?? f.max ?? 0);
              const max = f.max ?? Number(a.parameters[f.key] ?? 0);
              return (
                <label key={f.key} className="mt-2 block">
                  <span className="text-[13px] text-[#3c3c43]">
                    {f.label} <span className="text-[#8e8e93]">(max {max.toLocaleString()})</span>
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={max}
                    value={cur}
                    onChange={(e) => setEdits((s) => ({ ...s, [f.key]: Number(e.target.value) }))}
                    className="tnum mt-1 h-11 w-full rounded-xl bg-[#f2f2f7] px-3 text-[17px] font-semibold outline-none focus:ring-2 focus:ring-cobalt"
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 space-y-2 bg-gradient-to-t from-[#f2f2f7] via-[#f2f2f7] to-[#f2f2f7]/0 px-4 pb-7 pt-6">
        <AnimatePresence mode="wait">
          {result ? (
            <motion.div key="result" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl bg-white p-3.5 text-center">
              <CheckCircle2 className="mx-auto size-7 text-low" />
              <div className="mt-1 text-[15px] font-semibold">{result.message ?? "Decision recorded"}</div>
              {result.receipt_id && <div className="mt-0.5 font-mono text-[11px] text-[#6b7280]">Receipt {result.receipt_id} · Ed25519 signed</div>}
            </motion.div>
          ) : a.status !== "pending" || a.can_respond === false ? (
            <motion.div key="resolved" className="rounded-2xl bg-white p-3.5 text-center text-[14px] text-[#3c3c43]">
              {a.status === "pending" ? "You already responded — waiting for quorum." : `This request is ${a.status.replace("_", " ")}.`}
            </motion.div>
          ) : mode === "edit" ? (
            <motion.div key="edit" className="grid grid-cols-2 gap-2">
              <PhoneButton variant="secondary" onClick={() => setMode("view")}>Cancel</PhoneButton>
              <PhoneButton disabled={busy} onClick={() => submit({ decision: "approve_modified", modified_parameters: Object.fromEntries(a.editable_fields.map((f) => [f.key, edits[f.key] ?? Number(a.parameters[f.key] ?? 0)])) })}>
                Approve edited
              </PhoneButton>
            </motion.div>
          ) : (
            <motion.div key="actions" className="space-y-2">
              {a.safe_alternatives[0] && (
                <PhoneButton disabled={busy} onClick={() => submit({ decision: "safe_alternative", alternative_id: a.safe_alternatives[0].id })} className="bg-low hover:bg-[#0b6a3f]">
                  <Sparkles className="size-4 shrink-0" /> <span className="truncate">{a.safe_alternatives[0].label.length > 28 ? "Redirect safely" : a.safe_alternatives[0].label}</span>
                </PhoneButton>
              )}
              <div className={cn("grid gap-2", a.editable_fields.length ? "grid-cols-3" : "grid-cols-2")}>
                <PhoneButton variant="secondary" disabled={busy} onClick={() => submit({ decision: "reject" })}>
                  <X className="size-4" /> Reject
                </PhoneButton>
                {a.editable_fields.length > 0 && (
                  <PhoneButton variant="secondary" disabled={busy} onClick={() => setMode("edit")}>
                    <Pencil className="size-4" /> Edit
                  </PhoneButton>
                )}
                <PhoneButton variant={a.safe_alternatives[0] ? "secondary" : "primary"} disabled={busy} onClick={() => submit({ decision: "approve" })}>
                  Approve
                </PhoneButton>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {faceId && (
          <FaceIdSheet
            onDone={(ok) => {
              const p = faceId;
              setFaceId(null);
              if (ok) void onRespond(p);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export function PhoneButton({ children, variant = "primary", className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return (
    <button
      className={cn(
        "flex h-[50px] w-full items-center justify-center gap-1.5 rounded-2xl text-[16px] font-semibold transition active:scale-[0.98] disabled:opacity-50",
        variant === "primary" ? "bg-cobalt text-white" : "bg-white text-ink ring-1 ring-black/5",
        className,
      )}
      {...p}
    >
      {children}
    </button>
  );
}

/** Simulated Face ID (the native app uses LocalAuthentication; the server still verifies). */
export function FaceIdSheet({ onDone }: { onDone: (ok: boolean) => void }) {
  const [phase, setPhase] = React.useState<"scan" | "ok">("scan");
  const done = React.useRef(onDone);
  React.useEffect(() => {
    done.current = onDone;
  });
  React.useEffect(() => {
    const t1 = setTimeout(() => setPhase("ok"), 1100);
    const t2 = setTimeout(() => done.current(true), 1700);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-40 grid place-items-center bg-black/25 backdrop-blur-[2px]">
      <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="grid size-[150px] place-items-center rounded-[34px] bg-[#1c1c1e]/90 text-white">
        <div className="flex flex-col items-center gap-2">
          {phase === "scan" ? (
            <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ repeat: Infinity, duration: 0.9 }}>
              <ScanFace className="size-14" strokeWidth={1.4} />
            </motion.div>
          ) : (
            <CheckCircle2 className="size-14 text-[#30d158]" strokeWidth={1.4} />
          )}
          <span className="text-[14px] font-medium">Face ID</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function PhoneTabBar({ active = "inbox", badge }: { active?: string; badge?: number }) {
  const tabs = [
    { k: "inbox", label: "Inbox", icon: InboxIcon },
    { k: "activity", label: "Activity", icon: ActivityIcon },
    { k: "protect", label: "Protect", icon: ScanSearch },
    { k: "control", label: "Control", icon: OctagonPause },
    { k: "profile", label: "Profile", icon: CircleUser },
  ];
  return (
    <div className="absolute inset-x-0 bottom-0 grid grid-cols-5 border-t border-black/5 bg-white/90 px-2 pb-6 pt-2 backdrop-blur">
      {tabs.map((t) => (
        <span key={t.k} className={cn("relative flex flex-col items-center gap-0.5 text-[10px] font-medium", active === t.k ? "text-cobalt" : "text-[#8e8e93]")}>
          <t.icon className="size-[22px]" strokeWidth={active === t.k ? 2.2 : 1.8} />
          {t.label}
          {t.k === "inbox" && badge ? <span className="absolute -top-1 right-3 rounded-full bg-critical px-1 text-[9px] font-bold text-white">{badge}</span> : null}
        </span>
      ))}
    </div>
  );
}

export { Building2 };
