import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleAlert, Link2, ShieldCheck, Webhook, Zap } from "lucide-react";
import { currentConsoleUser } from "@/lib/server/auth";
import { computeAnalytics } from "@/lib/server/analytics";
import { actionSummary } from "@/lib/server/present";
import { verifyAuditChain } from "@/lib/server/store";
import { PageHeader } from "@/components/console/shell";
import { StatTile } from "@/components/console/stat";
import { Card, CardHeader, RiskBadge, StatusBadge, Badge } from "@/components/ui";
import { HBars, StackedColumns } from "@/components/charts";
import { Countdown, RelTime } from "@/components/console/time";
import { duration, usd, ROUTE_LABEL } from "@/lib/format";

export const dynamic = "force-dynamic";

const SERIES = [
  { key: "auto", label: "Autonomous", color: "var(--color-series-auto)" },
  { key: "human", label: "Human review", color: "var(--color-series-human)" },
  { key: "blocked", label: "Blocked", color: "var(--color-series-blocked)" },
];
const RISK_COLOR: Record<string, string> = { low: "#0ca30c", medium: "#fab219", high: "#ec835a", critical: "#d03b3b" };

export default async function Overview() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const a = computeAnalytics(db, 28);
  const pending = db.approvals
    .filter((p) => p.status === "pending")
    .sort((x, y) => y.risk.score - x.risk.score)
    .slice(0, 6);
  const recent = db.actions.slice(-9).reverse().map((x) => actionSummary(db, x));
  const chain = verifyAuditChain(db);
  const lat = db.actions.slice(-200).map((x) => x.latency_ms).sort((p, q) => p - q);
  const p50 = lat[Math.floor(lat.length / 2)] ?? 0;
  const p95 = lat[Math.floor(lat.length * 0.95)] ?? 0;
  const failing = db.webhooks.filter((w) => w.status !== "active");
  const weekly = a.series.slice(-12).map((d) => d.auto + d.human + d.blocked);
  const pawDelta = a.paw.previous ? ((a.paw.current - a.paw.previous) / a.paw.previous) * 100 : 0;
  const hour = new Date().getUTCHours() - 4;
  const greet = hour < 12 && hour >= 4 ? "Good morning" : hour < 18 && hour >= 12 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={`${greet}, ${user.name.split(" ")[0]}`}
        description={`${a.autonomy_retained}% of ${a.totals.actions.toLocaleString()} protected actions ran autonomously in the last ${a.window_days} days. ${pending.length} need a human right now.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Protected actions / week" value={a.paw.current} delta={{ value: pawDelta, label: "vs previous 7 days" }} trend={weekly} />
        <StatTile label="Autonomy retained" value={a.autonomy_retained} suffix="%" format={{ maximumFractionDigits: 1 }} hint="ran without a human" />
        <StatTile label="Awaiting human" value={pending.length} hint={`${db.approvals.filter((p) => p.status === "pending" && p.escalation_level > 0).length} escalated`} />
        <StatTile label="Median approval time" value={Math.round(a.approval_latency.median_s)} suffix="s" hint={`p95 ${duration(a.approval_latency.p95_s)}`} />
        <StatTile label="Value protected" value={a.impact.money_protected_usd} prefix="$" format={{ notation: "compact", maximumFractionDigits: 1 }} hint={`${a.impact.records_protected.toLocaleString()} records held back`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader title="Decisions per day" description="Every action that passed through the gateway, by how it was resolved" action={<Link href="/console/analytics" className="text-[13px] font-medium text-cobalt hover:underline">Analytics</Link>} />
          <div className="px-5 py-4">
            <StackedColumns height={300} data={a.series} series={SERIES} label="Decisions per day, stacked by autonomous, human review and blocked" />
          </div>
        </Card>

        <Card className="flex flex-col">
          <CardHeader title="Needs a decision" description="Highest risk first" action={<Link href="/console/approvals" className="text-[13px] font-medium text-cobalt hover:underline">All approvals</Link>} />
          <ul className="flex-1 divide-y divide-line">
            {pending.length === 0 && <li className="px-5 py-10 text-center text-[14px] text-muted">Nothing waiting. Safe work keeps running.</li>}
            {pending.map((p) => (
              <li key={p.id}>
                <Link href={`/console/approvals?id=${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{p.title}</div>
                    <div className="mt-0.5 truncate text-[12px] text-muted">
                      {p.actor.name} · {ROUTE_LABEL[p.route] ?? p.route}
                      {p.quorum ? ` · ${p.responses.length}/${p.quorum.required} signed` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <RiskBadge level={p.risk.level} score={p.risk.score} />
                    <Countdown to={p.expires_at} className="text-[12px] text-muted" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Risk mix" description={`Contextual risk score, last ${a.window_days} days`} />
          <div className="px-5 py-4">
            <HBars rows={a.risk_mix.map((r) => ({ key: r.level, label: <RiskBadge level={r.level} />, value: r.count, color: RISK_COLOR[r.level] }))} />
            <p className="mt-4 text-[12px] leading-relaxed text-muted">Risk prioritizes and routes. Deterministic policy decides enforcement — a score never overrides a hard rule.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Top blocked & rejected" description="Rules that stopped actions" />
          <div className="px-5 py-4">
            <HBars color="var(--color-series-blocked)" rows={a.top_blocked.map((b) => ({ key: b.rule, label: b.rule, sub: b.policy, value: b.count }))} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Platform health" />
          <ul className="divide-y divide-line text-[13.5px]">
            <Health icon={Zap} label="Gateway decision latency" value={`p50 ${p50}ms · p95 ${p95}ms`} ok />
            <Health icon={ShieldCheck} label="Audit chain" value={chain.ok ? `${chain.checked.toLocaleString()} events verified` : `Broken at #${chain.broken_at}`} ok={chain.ok} />
            <Health icon={Webhook} label="Webhooks" value={failing.length ? `${failing.length} endpoint failing (retrying)` : "All healthy"} ok={!failing.length} href="/console/integrations" />
            <Health icon={Link2} label="Integrations" value={`${db.integrations.filter((i) => i.kind !== "sandbox").length} connected · ${db.integrations.filter((i) => i.mode === "observe").length} observe-only`} ok />
            <Health icon={CheckCircle2} label="Policy coverage" value={`${a.policy_coverage.pct}% of action types`} ok={a.policy_coverage.pct >= 80} href="/console/policies" />
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Live activity" description="Most recent gateway decisions" action={<Link href="/console/actions" className="inline-flex items-center gap-1 text-[13px] font-medium text-cobalt hover:underline">Action explorer <ArrowRight className="size-3.5" /></Link>} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13.5px]">
            <tbody className="divide-y divide-line">
              {recent.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2/50">
                  <td className="px-5 py-2.5">
                    <Link href={`/console/actions?id=${r.id}`} className="font-medium hover:text-cobalt">{r.title}</Link>
                    <div className="text-[12px] text-muted">{r.actor.name} · {r.integration.name}</div>
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge status={r.final_status} /></td>
                  <td className="px-3 py-2.5"><RiskBadge level={r.risk.level} score={r.risk.score} /></td>
                  <td className="max-w-[260px] truncate px-3 py-2.5 text-[12.5px] text-muted">{r.rule ?? "No rule matched · default allow"}</td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-right text-[12px] text-muted"><RelTime iso={r.received_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-6 text-center text-[12px] text-faint">
        Showing {db.tenant.name} · {usd(a.impact.money_protected_usd)} held back by policy and human review · {a.impact.incidents_avoided} high-risk actions prevented or reshaped
        {" · "}
        <Badge tone="neutral">metadata-only payloads</Badge>
      </p>
    </>
  );
}

function Health({ icon: Icon, label, value, ok, href }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; ok: boolean; href?: string }) {
  const inner = (
    <div className="flex items-center gap-3 px-5 py-3">
      <Icon className="size-4 text-muted" />
      <span className="flex-1 text-ink-2">{label}</span>
      <span className={`flex items-center gap-1.5 text-[12.5px] font-medium ${ok ? "text-ink" : "text-high"}`}>
        {ok ? <CheckCircle2 className="size-3.5 text-low" /> : <CircleAlert className="size-3.5" />}
        {value}
      </span>
    </div>
  );
  return <li>{href ? <Link href={href} className="block hover:bg-surface-2/50">{inner}</Link> : inner}</li>;
}
