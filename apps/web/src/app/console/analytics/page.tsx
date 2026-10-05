import type { Metadata } from "next";
import Link from "next/link";
import { currentConsoleUser } from "@/lib/server/auth";
import { computeAnalytics } from "@/lib/server/analytics";
import { PageHeader } from "@/components/console/shell";
import { StatTile } from "@/components/console/stat";
import { HBars, Sparkline, StackedColumns } from "@/components/charts";
import { Avatar, Badge, Card, CardHeader, RiskBadge } from "@/components/ui";
import { duration, usd, cn } from "@/lib/format";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

const SERIES = [
  { key: "auto", label: "Autonomous", color: "var(--color-series-auto)" },
  { key: "human", label: "Human review", color: "var(--color-series-human)" },
  { key: "blocked", label: "Blocked", color: "var(--color-series-blocked)" },
];

export default async function AnalyticsPage({ searchParams }: PageProps<"/console/analytics">) {
  const sp = await searchParams;
  const days = [7, 14, 28].includes(Number(sp.days)) ? Number(sp.days) : 28;
  const { db } = await currentConsoleUser();
  const a = computeAnalytics(db, days);
  const users = Object.fromEntries(db.users.map((u) => [u.id, u]));
  return (
    <>
      <PageHeader
        eyebrow="Value"
        title="Analytics"
        description="Generated from real decision events — not a mock. The goal is proportional control: humans only see decisions that genuinely need judgment."
        actions={
          <div className="inline-flex rounded-[10px] bg-surface-2 p-0.5 ring-1 ring-inset ring-line">
            {[7, 14, 28].map((d) => (
              <Link key={d} href={`/console/analytics?days=${d}`} className={cn("rounded-[8px] px-3 py-1.5 text-[13px] font-medium", d === days ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>
                Last {d} days
              </Link>
            ))}
          </div>
        }
      />
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">North-star metrics</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatTile label="Protected actions / week" value={a.paw.current} delta={{ value: a.paw.previous ? ((a.paw.current - a.paw.previous) / a.paw.previous) * 100 : 0, label: "vs prior week" }} />
        <StatTile label="Autonomy retained" value={a.autonomy_retained} suffix="%" hint="stayed automatic" />
        <StatTile label="Mean approval time" value={a.approval_latency.mean_s} suffix="s" hint={`p95 ${duration(a.approval_latency.p95_s)}`} />
        <StatTile label="False friction" value={a.false_friction} suffix="%" hint="approvals marked unnecessary" />
        <StatTile label="Safe redirect rate" value={a.safe_redirect_rate} suffix="%" hint={`${a.modified_rate}% approved with changes`} />
        <StatTile label="Policy coverage" value={a.policy_coverage.pct} suffix="%" hint={`${a.policy_coverage.covered}/${a.policy_coverage.total} action types`} />
        <StatTile label="Median activation" value={Math.round([...a.activation.map((x) => x.minutes)].sort((p, q) => p - q)[Math.floor(a.activation.length / 2)] ?? 0)} suffix=" min" hint="key → first protected action" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader title="Automation throughput" description={`${a.totals.actions.toLocaleString()} enforced actions · ${a.totals.observed} observe-only events`} />
          <div className="px-5 py-4"><StackedColumns height={280} data={a.series} series={SERIES} label="Daily throughput by resolution" /></div>
        </Card>
        <Card>
          <CardHeader title="Business impact" description="What policy and humans held back" />
          <div className="grid grid-cols-2 gap-px bg-line">
            {[
              { k: "Money held back", v: usd(a.impact.money_protected_usd, true) },
              { k: "Records not exported", v: a.impact.records_protected.toLocaleString() },
              { k: "High-risk prevented", v: String(a.impact.incidents_avoided) },
              { k: "Approvals expired", v: String(a.expired) },
            ].map((x) => (
              <div key={x.k} className="bg-surface px-5 py-4">
                <div className="text-[12.5px] text-muted">{x.k}</div>
                <div className="tnum mt-1 text-[24px] font-semibold tracking-[-0.02em]">{x.v}</div>
              </div>
            ))}
          </div>
          <div className="px-5 py-4">
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Risk distribution</div>
            <HBars rows={a.risk_mix.map((r) => ({ key: r.level, label: <RiskBadge level={r.level} />, value: r.count, color: { low: "#0ca30c", medium: "#fab219", high: "#ec835a", critical: "#d03b3b" }[r.level] }))} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Approver response time" description="How fast each human resolves what Orbis sends them" />
          <table className="w-full text-[13.5px]">
            <thead className="border-b border-line text-left text-[12px] text-muted"><tr><th className="px-5 py-2 font-medium">Approver</th><th className="px-3 py-2 text-right font-medium">Decisions</th><th className="px-3 py-2 text-right font-medium">Median</th><th className="px-5 py-2 text-right font-medium">p95</th></tr></thead>
            <tbody className="tnum divide-y divide-line">
              {a.approvers.map((x) => (
                <tr key={x.user_id}>
                  <td className="px-5 py-2.5"><span className="flex items-center gap-2.5"><Avatar name={x.name} color={users[x.user_id]?.color} size={24} /><span><span className="block font-medium">{x.name}</span><span className="block text-[11.5px] text-muted">{x.title}</span></span></span></td>
                  <td className="px-3 text-right">{x.responses}</td>
                  <td className="px-3 text-right">{duration(x.median_s)}</td>
                  <td className="px-5 text-right text-muted">{duration(x.p95_s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <CardHeader title="Agent behaviour" description="Volume vs baseline, last 48 hours" />
          <table className="w-full text-[13.5px]">
            <thead className="border-b border-line text-left text-[12px] text-muted"><tr><th className="px-5 py-2 font-medium">Actor</th><th className="px-3 py-2 font-medium">48h trend</th><th className="px-3 py-2 text-right font-medium">Human</th><th className="px-5 py-2 text-right font-medium">Blocked</th></tr></thead>
            <tbody className="tnum divide-y divide-line">
              {a.actors.slice(0, 9).map((x) => (
                <tr key={x.id}>
                  <td className="px-5 py-2"><span className="font-medium">{x.name}</span>{x.frozen && <Badge tone="critical" className="ml-2">Frozen</Badge>}{x.anomalies > 0 && !x.frozen && <Badge tone="medium" className="ml-2">{x.anomalies} anomalies</Badge>}<div className="text-[11.5px] capitalize text-muted">{x.type} · {x.total} actions</div></td>
                  <td className="px-3"><Sparkline values={x.hourly} width={120} height={26} accent={x.frozen ? "var(--color-critical)" : undefined} /></td>
                  <td className="px-3 text-right">{x.human}</td>
                  <td className="px-5 text-right">{x.blocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Integration activation time" description="Minutes from API key creation to the first protected production action — the developer-experience metric" />
        <div className="p-5"><HBars color="var(--color-series-auto)" suffix=" min" rows={a.activation.sort((p, q) => p.minutes - q.minutes).map((x) => ({ key: x.id, label: x.name, value: x.minutes }))} /></div>
      </Card>
    </>
  );
}
