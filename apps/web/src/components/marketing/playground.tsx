"use client";
import * as React from "react";
import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import { Ban, CheckCircle2, Fingerprint, Hourglass, Sparkles, TriangleAlert, Users } from "lucide-react";
import type { ActionEnvelope, Classification } from "@orbis/policy-core";
import { cn, ROUTE_LABEL } from "@/lib/format";
import { EFFECT_LABEL } from "@/lib/policy-text";
import { runEngine } from "./engine";

type T = "external_send" | "payment" | "refund" | "deploy" | "data_export" | "grant_access";
const TYPES: Array<{ v: T; label: string }> = [
  { v: "external_send", label: "AI tool call" },
  { v: "payment", label: "Payment" },
  { v: "refund", label: "Refund" },
  { v: "deploy", label: "Deploy" },
  { v: "data_export", label: "Data export" },
  { v: "grant_access", label: "Access grant" },
];
const AMOUNTS = [50, 400, 900, 2500, 4000, 8500, 12000, 25000, 84000, 150000, 310000];
const RECORDS = [200, 2000, 9000, 15000, 40000, 120000];

export function Playground() {
  const [type, setType] = React.useState<T>("external_send");
  const [cls, setCls] = React.useState<Classification>("confidential");
  const [dest, setDest] = React.useState<"allowlisted" | "known" | "new">("new");
  const [amountI, setAmountI] = React.useState(5);
  const [recI, setRecI] = React.useState(5);
  const [prod, setProd] = React.useState(true);
  const [window, setWindow] = React.useState(true);
  const [anomaly, setAnomaly] = React.useState(false);
  const [ticket, setTicket] = React.useState(false);
  const [frozen, setFrozen] = React.useState(false);

  const env: ActionEnvelope = React.useMemo(() => {
    const destination =
      type === "external_send"
        ? dest === "allowlisted"
          ? { type: "internal_model" as const, value: "northstar-private-llm" }
          : { type: "external_model" as const, value: dest === "known" ? "contoso-retail.com" : "quickscribe-ai.app" }
        : type === "payment"
          ? { type: "beneficiary" as const, value: dest === "allowlisted" ? "acme-supplies.com" : dest === "known" ? "contoso-retail.com" : "brightline-fab.com" }
          : undefined;
    return {
      request_id: "pg",
      actor: { type: type === "grant_access" ? "human" : "agent", id: "playground-agent" },
      action: { type },
      resources: [{ type: "resource", classification: cls, environment: type === "deploy" || type === "grant_access" ? (prod ? "production" : "staging") : undefined, count: type === "external_send" ? 4 : 1 }],
      destination,
      business_context: {
        ...(type === "payment" || type === "refund" ? { amount_usd: AMOUNTS[amountI] } : {}),
        ...(type === "data_export" ? { record_count: RECORDS[recI] } : {}),
        ...(type === "grant_access" ? { duration_minutes: 30 } : {}),
        ...(ticket ? { ticket: "SEC-4411" } : {}),
      },
      signals: { actor_anomaly: anomaly, outside_change_window: type === "deploy" && window, tests_passed: true },
      intent: { reason: "Playground request with a business justification" },
    };
  }, [type, cls, dest, amountI, recI, prod, window, anomaly, ticket]);

  const r = React.useMemo(() => runEngine(env, frozen ? ["playground-agent"] : []), [env, frozen]);
  const meta = {
    allow: { icon: CheckCircle2, label: "Allow", tone: "text-low bg-low-bg", line: "Runs autonomously. Logged; receipt issued." },
    warn: { icon: TriangleAlert, label: "Allow + warn", tone: "text-medium bg-medium-bg", line: "Runs. The owning team is notified." },
    approval_required: { icon: Hourglass, label: "Pause for a human", tone: "text-cobalt bg-cobalt-50", line: "Paused. A verified human decides on iPhone." },
    deny: { icon: Ban, label: frozen ? "Deny · frozen" : "Deny", tone: "text-critical bg-critical-bg", line: frozen ? "Actor is frozen. Every request is rejected." : "Blocked by a hard rule. No approval can override it." },
  }[r.status];
  const Icon = meta.icon;

  const chip = (on: boolean, label: string, set: (v: boolean) => void) => (
    <button onClick={() => set(!on)} aria-pressed={on} className={cn("rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 ring-inset transition", on ? "bg-ink text-white ring-ink" : "bg-surface text-ink-2 ring-line hover:ring-line-strong")}>{label}</button>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.05fr]">
      <div className="space-y-5 rounded-[22px] border border-line bg-surface p-6 shadow-card">
        <Group label="Proposed action">
          <div className="flex flex-wrap gap-1.5">
            {TYPES.map((t) => (
              <button key={t.v} onClick={() => setType(t.v)} className={cn("rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 ring-inset", type === t.v ? "bg-cobalt text-white ring-cobalt" : "bg-surface text-ink-2 ring-line hover:ring-line-strong")}>{t.label}</button>
            ))}
          </div>
        </Group>
        <Group label="Data classification">
          <div className="grid grid-cols-5 gap-1 rounded-xl bg-surface-2 p-1">
            {(["public", "internal", "confidential", "restricted", "regulated"] as Classification[]).map((c) => (
              <button key={c} onClick={() => setCls(c)} className={cn("rounded-lg py-1.5 text-[12.5px] font-medium capitalize", cls === c ? "bg-surface text-ink shadow-card" : "text-muted")}>{c}</button>
            ))}
          </div>
        </Group>
        {(type === "external_send" || type === "payment") && (
          <Group label="Destination">
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
              {(["allowlisted", "known", "new"] as const).map((d) => (
                <button key={d} onClick={() => setDest(d)} className={cn("rounded-lg py-1.5 text-[12.5px] font-medium", dest === d ? "bg-surface text-ink shadow-card" : "text-muted")}>{d === "allowlisted" ? "Allowlisted" : d === "known" ? "Seen before" : "Brand new"}</button>
              ))}
            </div>
          </Group>
        )}
        {(type === "payment" || type === "refund") && (
          <Group label={`Amount · $${AMOUNTS[amountI].toLocaleString()}`}>
            <input type="range" min={0} max={AMOUNTS.length - 1} value={amountI} onChange={(e) => setAmountI(Number(e.target.value))} className="w-full accent-[var(--color-cobalt)]" aria-label="Amount" />
          </Group>
        )}
        {type === "data_export" && (
          <Group label={`Records · ${RECORDS[recI].toLocaleString()}`}>
            <input type="range" min={0} max={RECORDS.length - 1} value={recI} onChange={(e) => setRecI(Number(e.target.value))} className="w-full accent-[var(--color-cobalt)]" aria-label="Records" />
          </Group>
        )}
        <Group label="Context">
          <div className="flex flex-wrap gap-1.5">
            {(type === "deploy" || type === "grant_access") && chip(prod, "Production", setProd)}
            {type === "deploy" && chip(window, "Outside change window", setWindow)}
            {type === "data_export" && chip(ticket, "Exception ticket attached", setTicket)}
            {chip(anomaly, "Behaviour anomaly", setAnomaly)}
            {chip(frozen, "Actor frozen", setFrozen)}
          </div>
        </Group>
      </div>

      <div className="rounded-[22px] border border-line bg-surface shadow-card">
        <div className={cn("flex items-center gap-4 rounded-t-[22px] px-6 py-5", meta.tone)}>
          <motion.span key={r.status} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="grid size-12 place-items-center rounded-2xl bg-white/70"><Icon className="size-6" /></motion.span>
          <div className="min-w-0 flex-1">
            <div className="text-[22px] font-semibold tracking-[-0.02em]">{meta.label}</div>
            <div className="text-[13.5px] opacity-80">{meta.line}</div>
          </div>
          <div className="text-right">
            <div className="text-[30px] font-semibold leading-none tracking-[-0.03em]"><NumberFlow value={r.risk.score} /></div>
            <div className="text-[11.5px] uppercase tracking-wide opacity-70">risk · {r.risk.level}</div>
          </div>
        </div>
        <div className="space-y-5 p-6">
          {r.deciding ? (
            <div>
              <div className="text-[12px] font-semibold uppercase tracking-wider text-muted">Deciding rule</div>
              <div className="mt-1 text-[15px] font-semibold">{r.deciding.rule_name}</div>
              <div className="text-[13.5px] text-ink-2">{r.deciding.reason}</div>
              <div className="mt-1 font-mono text-[11.5px] text-faint">{r.deciding.policy_name} · v{r.deciding.version} · {EFFECT_LABEL[r.deciding.effect]}</div>
            </div>
          ) : (
            <div className="text-[13.5px] text-muted">No rule matched — default allow. (Coverage gaps like this show up in Policy Studio.)</div>
          )}
          {r.approval && (
            <div className="flex flex-wrap gap-2 text-[12.5px]">
              <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 ring-1 ring-inset ring-line"><Users className="size-3.5" /> {ROUTE_LABEL[r.approval.route] ?? r.approval.route}</span>
              {r.approval.step_up === "biometric" && <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 ring-1 ring-inset ring-line"><Fingerprint className="size-3.5" /> Face ID step-up</span>}
              {r.approval.quorum && <span className="rounded-full bg-surface-2 px-2.5 py-1 ring-1 ring-inset ring-line">Quorum {r.approval.quorum.required} of {r.approval.quorum.of}</span>}
            </div>
          )}
          {r.safe_alternatives[0] && (
            <div className="flex gap-2.5 rounded-xl bg-low-bg px-3.5 py-3 text-[13px] text-low">
              <Sparkles className="mt-0.5 size-4 shrink-0" />
              <span><span className="font-semibold">{r.safe_alternatives[0].label}.</span> <span className="text-ink-2">{r.safe_alternatives[0].description}</span></span>
            </div>
          )}
          <div>
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Risk factors (prioritise & route — never override)</div>
            <ul className="space-y-1.5">
              {r.risk.reasons.length === 0 && <li className="text-[13px] text-muted">No risk factors.</li>}
              {r.risk.reasons.map((x) => (
                <li key={x.code} className="flex items-center gap-3 text-[13px]">
                  <span className="flex-1 text-ink-2">{x.label}</span>
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2"><span className={cn("block h-full rounded-full", x.weight > 0 ? "bg-high" : "bg-low")} style={{ width: `${Math.min(100, Math.abs(x.weight) * 3)}%` }} /></span>
                  <span className={cn("tnum w-8 text-right font-medium", x.weight > 0 ? "text-high" : "text-low")}>{x.weight > 0 ? `+${x.weight}` : x.weight}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-line pt-3 font-mono text-[11.5px] text-faint" suppressHydrationWarning>evaluated in {r.micros}µs · {r.matched.length} rule{r.matched.length === 1 ? "" : "s"} matched · deterministic, no model call</div>
        </div>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      {children}
    </div>
  );
}
