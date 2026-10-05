"use client";
import Link from "next/link";
import * as React from "react";
import { Boxes, CheckCircle2, CircleAlert, Eye, KeyRound, Plus, ShieldCheck, Webhook } from "lucide-react";
import { Sparkline } from "@/components/charts";
import { RelTime } from "@/components/console/time";
import { Badge, Button, Card, CardHeader, Mono, StatusBadge } from "@/components/ui";
import { cn, dateTime, duration } from "@/lib/format";

export interface IntegrationVM {
  id: string;
  name: string;
  vendor: string;
  kind: string;
  description: string;
  mode: string;
  status: string;
  sdk: string;
  created_at: string;
  first_protected_at: string | null;
  last_seen_at: string | null;
  actors: string[];
  keys: Array<{ id: string; label: string; prefix: string; environment: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null }>;
  daily: number[];
  week_total: number;
  week_human: number;
  week_denied: number;
  p95_latency: number;
  last_decision: { id: string; title: string; final_status: string; received_at: string } | null;
  webhook: { url: string; status: string; secret_hint: string; events: string[]; success_rate: number; recent: Array<{ id: string; event: string; status_code: number; attempt: number; at: string; ms: number }> } | null;
}

export function IntegrationsView({ items }: { items: IntegrationVM[] }) {
  const [sel, setSel] = React.useState(items[0]?.id);
  const cur = items.find((i) => i.id === sel) ?? items[0];
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_460px]">
      <div className="grid content-start gap-3 md:grid-cols-2">
        {items.map((i) => (
          <button key={i.id} onClick={() => setSel(i.id)} className="text-left">
            <Card className={cn("h-full p-4 transition hover:border-cobalt/40", sel === i.id && "border-cobalt ring-4 ring-cobalt-100")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold">{i.name}</div>
                  <div className="text-[12.5px] text-muted">{i.vendor}</div>
                </div>
                <HealthPill status={i.status} mode={i.mode} />
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div className="text-[12.5px] text-muted">
                  <span className="tnum text-[18px] font-semibold text-ink">{i.week_total}</span> actions / 7d
                  <div className="tnum">{i.week_human} to humans · {i.week_denied} denied</div>
                </div>
                <Sparkline values={i.daily} width={110} height={34} label={`${i.name} daily volume`} />
              </div>
            </Card>
          </button>
        ))}
        <Card className="grid place-items-center border-dashed p-6 text-center md:col-span-2">
          <Boxes className="size-6 text-cobalt" />
          <p className="mt-2 text-[14px] font-semibold">Connect another system</p>
          <p className="mt-1 max-w-sm text-[13px] text-muted">Create a key, call <Mono>POST /v1/decisions/preflight</Mono> before the risky step, and you're protected — median activation here was under 30 minutes.</p>
          <Button asChild variant="primary" size="sm" className="mt-3"><Link href="/console/developer"><Plus className="size-4" /> New integration</Link></Button>
        </Card>
      </div>

      {cur && (
        <Card className="h-fit xl:sticky xl:top-20">
          <CardHeader title={cur.name} description={cur.description} action={<HealthPill status={cur.status} mode={cur.mode} />} />
          <div className="space-y-5 p-5 text-[13.5px]">
            <dl className="grid grid-cols-2 gap-3">
              <Stat label="Pattern" value={cur.mode === "observe" ? "Event-only / observe" : cur.kind === "workflow" ? "Approval API + preflight" : "Preflight API"} />
              <Stat label="SDK" value={cur.sdk} />
              <Stat label="p95 decision" value={`${cur.p95_latency} ms`} />
              <Stat label="Activation" value={cur.first_protected_at ? duration((new Date(cur.first_protected_at).getTime() - new Date(cur.created_at).getTime()) / 1000) : "—"} hint="key → first protected action" />
              <Stat label="Last seen" value={cur.last_seen_at ? <RelTime iso={cur.last_seen_at} /> : "never"} />
              <Stat label="Actors" value={cur.actors.join(", ")} />
            </dl>

            {cur.mode === "observe" && (
              <div className="flex gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2">
                <Eye className="mt-0.5 size-4 shrink-0 text-muted" />
                Observe mode: Orbis scores and records every action but never blocks. Graduate to enforcement once the policy simulator shows acceptable friction.
              </div>
            )}

            {cur.last_decision && (
              <div>
                <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted">Last decision</div>
                <Link href={`/console/actions?id=${cur.last_decision.id}`} className="flex items-center justify-between gap-2 rounded-xl border border-line px-3.5 py-2.5 hover:border-cobalt/40">
                  <span className="truncate font-medium">{cur.last_decision.title}</span>
                  <StatusBadge status={cur.last_decision.final_status} />
                </Link>
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted"><KeyRound className="size-3.5" /> API keys</div>
              <ul className="space-y-1.5">
                {cur.keys.map((k) => (
                  <li key={k.id} className={cn("rounded-xl border border-line px-3.5 py-2.5", k.revoked_at && "opacity-60")}>
                    <div className="flex items-center justify-between gap-2">
                      <Mono>{k.prefix}••••••••</Mono>
                      {k.revoked_at ? <Badge tone="neutral">Revoked</Badge> : <Badge tone={k.environment === "production" ? "cobalt" : "neutral"}>{k.environment}</Badge>}
                    </div>
                    <div className="mt-1 text-[12px] text-muted">{k.label} · created {dateTime(k.created_at)} · {k.last_used_at ? <>last used <RelTime iso={k.last_used_at} /></> : "unused this session"}</div>
                    <div className="mt-1 flex flex-wrap gap-1">{k.scopes.map((s) => <span key={s} className="font-mono text-[10.5px] text-faint">{s}</span>)}</div>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11.5px] text-faint">Keys are SHA-256 hashed at rest and shown once at creation. Tenant is derived from the key, never from the payload.</p>
            </div>

            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted"><Webhook className="size-3.5" /> Webhook</div>
              {cur.webhook ? (
                <div className="rounded-xl border border-line">
                  <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
                    <Mono className="truncate">{cur.webhook.url}</Mono>
                    <span className={cn("flex shrink-0 items-center gap-1 text-[12px] font-medium", cur.webhook.status === "active" ? "text-low" : "text-high")}>
                      {cur.webhook.status === "active" ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                      {cur.webhook.success_rate}% delivered
                    </span>
                  </div>
                  <ul className="divide-y divide-line">
                    {cur.webhook.recent.map((d) => (
                      <li key={d.id} className="flex items-center gap-3 px-3.5 py-1.5 text-[12px]">
                        <span className={cn("tnum w-9 font-mono font-semibold", d.status_code < 300 ? "text-low" : "text-critical")}>{d.status_code}</span>
                        <span className="flex-1 font-mono text-ink-2">{d.event}</span>
                        {d.attempt > 1 && <span className="text-high">retry {d.attempt}</span>}
                        <span className="tnum text-muted">{d.ms}ms</span>
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-line px-3.5 py-2 text-[11.5px] text-faint">Signed with {cur.webhook.secret_hint} · HMAC-SHA256 · 5-min replay window · exponential backoff, dead-letter after 8 attempts</div>
                </div>
              ) : (
                <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No webhook — this integration polls <Mono>GET /v1/approvals/:id</Mono> via the SDK.</p>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function HealthPill({ status, mode }: { status: string; mode: string }) {
  if (mode === "observe") return <Badge tone="neutral"><Eye className="size-3.5" /> Observe</Badge>;
  if (status === "healthy") return <Badge tone="low"><ShieldCheck className="size-3.5" /> Enforcing</Badge>;
  return <Badge tone="high"><CircleAlert className="size-3.5" /> Degraded</Badge>;
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
      {hint && <dd className="text-[11px] text-faint">{hint}</dd>}
    </div>
  );
}
