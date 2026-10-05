"use client";
import Link from "next/link";
import * as React from "react";
import { Bot, CheckCircle2, CircleDot, FileCheck2, Gavel, Loader2, Send, ShieldQuestion, UserCheck, X } from "lucide-react";
import type { ActionRecord, ApprovalRecord, Receipt } from "@/lib/domain";
import { Badge, Mono, RiskBadge, StatusBadge } from "@/components/ui";
import { cn, dateTime, ROUTE_LABEL, usd } from "@/lib/format";
import { api } from "./live";

interface Detail {
  action: ActionRecord;
  approval: (ApprovalRecord & { final_status?: string }) | null;
  receipt: (Receipt & { revisions: Array<{ revision: number; body_hash: string; issued_at: string }> }) | null;
  summary: { title: string; actor: { name: string }; integration: { name: string } };
}

export function ActionInspector({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = React.useState<Detail | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    api<Detail>(`/api/v1/actions/${id}`).then(setD, (e) => setErr(e.message));
  }, [id]);

  return (
    <aside className="flex h-full flex-col border-l border-line bg-surface" aria-label="Action inspector">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-muted">Action</div>
          <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em]">{d?.summary.title ?? "Loading…"}</h2>
          <Mono className="text-muted">{id}</Mono>
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-surface-2" aria-label="Close inspector">
          <X className="size-4" />
        </button>
      </div>
      {err && <p className="p-5 text-[13px] text-critical">{err}</p>}
      {!d && !err && (
        <div className="grid flex-1 place-items-center">
          <Loader2 className="size-5 animate-spin text-muted" />
        </div>
      )}
      {d && <InspectorBody d={d} />}
    </aside>
  );
}

function InspectorBody({ d }: { d: Detail }) {
  const { action: a, approval: p, receipt: r } = d;
  const env = a.envelope;
  return (
    <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[13.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={a.final_status} />
        <RiskBadge level={a.evaluation.risk.level} score={a.evaluation.risk.score} />
        {a.mode === "observe" && <StatusBadge status="observe" />}
        {a.evaluation.frozen && <StatusBadge status="frozen" />}
        <Badge tone="neutral">{a.latency_ms}ms decision</Badge>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
        <dt className="text-muted">Actor</dt>
        <dd>
          {d.summary.actor.name} <span className="text-muted">({env.actor.type})</span>
        </dd>
        <dt className="text-muted">Integration</dt>
        <dd>{d.summary.integration.name}</dd>
        <dt className="text-muted">Tool</dt>
        <dd><Mono>{env.action.tool ?? env.action.type}</Mono></dd>
        {env.destination && (
          <>
            <dt className="text-muted">Destination</dt>
            <dd>{env.destination.value} <span className="text-muted">· {env.destination.type.replace(/_/g, " ")}</span></dd>
          </>
        )}
        {env.business_context?.amount_usd !== undefined && (
          <>
            <dt className="text-muted">Amount</dt>
            <dd className="tnum">{usd(Number(env.business_context.amount_usd))}</dd>
          </>
        )}
        {env.intent?.reason && (
          <>
            <dt className="text-muted">Intent</dt>
            <dd>“{env.intent.reason}”</dd>
          </>
        )}
      </dl>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Trust timeline</h3>
        <TrustTimeline action={a} approval={p} receipt={r} />
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Policy evaluation</h3>
        {a.evaluation.matched.length === 0 ? (
          <p className="text-muted">No rule matched — default allow. Consider adding coverage for <Mono>{env.action.type}</Mono>.</p>
        ) : (
          <ul className="space-y-1.5">
            {a.evaluation.matched.map((m, i) => (
              <li key={m.rule_id + i} className={cn("rounded-lg border px-3 py-2", i === 0 ? "border-cobalt/30 bg-cobalt-50/50" : "border-line")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{m.rule_name}</span>
                  <Badge tone={i === 0 ? "cobalt" : "neutral"}>{m.effect.replace(/_/g, " ")}</Badge>
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {m.policy_name} · v{m.version} {i === 0 && "· deciding rule"}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <div className="mb-1 text-[12px] text-muted">Risk factors</div>
          <ul className="space-y-1">
            {a.evaluation.risk.reasons.map((x) => (
              <li key={x.code} className="flex justify-between gap-2 text-[13px]">
                <span>{x.label}</span>
                <span className={cn("tnum font-medium", x.weight > 0 ? "text-high" : "text-low")}>{x.weight > 0 ? `+${x.weight}` : x.weight}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {r && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Decision receipt</h3>
          <Link href={`/console/receipts/${r.id}`} className="block rounded-xl border border-line px-3.5 py-3 hover:border-cobalt/40 hover:bg-cobalt-50/30">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 font-medium">
                <FileCheck2 className="size-4 text-low" /> {r.id}
              </span>
              <Badge tone="low">Ed25519 signed</Badge>
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted">sha256 {r.body_hash.slice(0, 32)}…</div>
            <div className="mt-1 text-[12px] text-muted">{r.revisions.length} revision{r.revisions.length > 1 ? "s" : ""} · open receipt viewer →</div>
          </Link>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Envelope (metadata only)</h3>
        <pre className="max-h-64 overflow-auto rounded-xl bg-night p-3 font-mono text-[11.5px] leading-relaxed text-white/85">{JSON.stringify({ ...env, evidence: env.evidence?.length ? `[${env.evidence.length} items]` : undefined }, null, 2)}</pre>
        <div className="mt-1 font-mono text-[11px] text-muted">envelope_hash {a.envelope_hash.slice(0, 40)}…</div>
      </section>
    </div>
  );
}

export function TrustTimeline({ action: a, approval: p, receipt: r }: { action: ActionRecord | null; approval: ApprovalRecord | null; receipt: Receipt | null }) {
  const steps: Array<{ icon: React.ComponentType<{ className?: string }>; title: string; detail?: string; at: string; tone?: "ok" | "bad" | "info" }> = [];
  if (a) steps.push({ icon: Bot, title: `${a.envelope.actor.type === "human" ? "Human" : "Software"} proposed the action`, detail: `${a.envelope.action.tool ?? a.envelope.action.type} · request ${a.request_id}`, at: a.received_at });
  if (a) steps.push({
    icon: Gavel,
    title: `Policy decided: ${a.evaluation.status.replace("_", " ")}`,
    detail: a.evaluation.deciding ? `${a.evaluation.deciding.rule_name} (v${a.evaluation.deciding.version}) · ${a.latency_ms}ms` : `No matching rule · ${a.latency_ms}ms`,
    at: a.decided_at,
    tone: a.evaluation.status === "deny" ? "bad" : a.evaluation.status === "approval_required" ? "info" : "ok",
  });
  if (p) {
    steps.push({ icon: ShieldQuestion, title: `Routed to ${ROUTE_LABEL[p.route] ?? p.route}`, detail: `${p.assignees.length} approvers${p.step_up === "biometric" ? " · biometric step-up" : ""}${p.quorum ? ` · quorum ${p.quorum.required}/${p.quorum.of}` : ""}`, at: p.created_at, tone: "info" });
    if (p.escalated_at) steps.push({ icon: CircleDot, title: "SLA escalation", detail: "50% of TTL elapsed", at: p.escalated_at, tone: "info" });
    for (const x of p.responses)
      steps.push({
        icon: UserCheck,
        title: `${x.user_name} ${x.decision === "reject" ? "rejected" : x.decision === "safe_alternative" ? "chose safe alternative" : x.decision === "approve_modified" ? "edited & approved" : "approved"}`,
        detail: `${x.channel === "ios" ? "Orbis iOS" : "Web console"}${x.step_up.verified ? ` · ${x.step_up.method === "biometric" ? "Face ID" : "passkey"} verified` : ""}${x.comment ? ` · “${x.comment}”` : ""}`,
        at: x.responded_at,
        tone: x.decision === "reject" ? "bad" : "ok",
      });
    if (p.resolved_at) steps.push({ icon: CheckCircle2, title: `Resolved: ${p.status.replace("_", " ")}`, at: p.resolved_at, tone: p.status === "rejected" || p.status === "expired" ? "bad" : "ok" });
  }
  if (r) steps.push({ icon: FileCheck2, title: `Receipt issued (rev ${r.revision})`, detail: r.id, at: r.body.issued_at, tone: "ok" });
  if (a?.outcome) steps.push({ icon: Send, title: `Caller reported: ${a.outcome.status.replace("_", " ")}`, detail: a.outcome.detail, at: a.outcome.reported_at, tone: a.outcome.status === "failed" ? "bad" : "ok" });
  return (
    <ol className="relative ml-1 space-y-3 border-l border-line pl-5">
      {steps.map((s, i) => {
        const Icon = s.icon;
        return (
          <li key={i} className="relative">
            <span className={cn("absolute -left-[31px] top-0 grid size-[22px] place-items-center rounded-full ring-4 ring-surface", s.tone === "bad" ? "bg-critical-bg text-critical" : s.tone === "info" ? "bg-cobalt-50 text-cobalt" : "bg-low-bg text-low")}>
              <Icon className="size-3" />
            </span>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{s.title}</span>
              <time className="tnum shrink-0 text-[11.5px] text-muted">{dateTime(s.at)}</time>
            </div>
            {s.detail && <div className="mt-0.5 text-[12px] text-muted">{s.detail}</div>}
          </li>
        );
      })}
    </ol>
  );
}
