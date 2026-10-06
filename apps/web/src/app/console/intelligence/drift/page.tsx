import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { computeDrift, reviewQueue } from "@/lib/server/ml";
import { PageHeader } from "@/components/console/shell";
import { Sparkline } from "@/components/charts";
import { Badge, Card, CardHeader } from "@/components/ui";
import { IntelTabs } from "@/components/console/intel";
import { pct } from "@/lib/ml-format";
import { cn, shortDate } from "@/lib/format";
import e110 from "@/lib/ml/edge/eval/1.1.0.json";

export const metadata: Metadata = { title: "Drift · Intelligence" };
export const dynamic = "force-dynamic";

const LEVEL_TONE = { ok: "low", info: "neutral", warn: "high", critical: "critical" } as const;
const psiColor = (v: number) => (v >= 0.25 ? "var(--color-critical-bg)" : v >= 0.1 ? "var(--color-medium-bg)" : "var(--color-surface)");

type Offline = { drift_windows: Array<{ days: number[]; n: number; level: string; max_feature_psi: number; prediction_psi: number; ood_rate: number; top_features: Array<{ feature: string; psi: number }>; false_escalation_rate_on_window: number | null }>; trigger: { reason: string; propose_candidate_retraining: boolean; auto_promote: boolean }; review_queue: { queued: number; reviewed: number; budget: number }; why: string };

export default async function DriftPage() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const d = computeDrift(db);
  const names = d.windows[0]?.features.map((f) => f.feature).sort() ?? [];
  const off = (e110 as unknown as { retrain: Offline | null }).retrain;
  const actorName = (id: string) => db.actors.find((a) => a.id === id)?.name ?? id;
  return (
    <>
      <PageHeader eyebrow="Production quality" title="Drift" description="Interpretable statistics only: PSI on monitored features and on the calibrated risk score, plus the out-of-distribution rate. Windows are 7 days — shorter ones alias weekends into “drift”." />
      <IntelTabs reviewCount={reviewQueue(db, 0).total} />
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader title="Live gateway traffic" description={`Features vs ${d.reference.n.toLocaleString()} decisions before ${shortDate(d.reference.end)} · risk score vs the first 4 days of ${d.reference.prediction_reference.model_version} (${d.reference.prediction_reference.n}) · rolling 7-day windows`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12.5px]">
              <thead className="text-[11.5px] text-muted"><tr><th className="px-5 py-2 text-left font-medium">Feature PSI</th>{d.windows.map((w, i) => <th key={i} className="px-1.5 py-2 text-center font-medium">→ {shortDate(w.end)}</th>)}</tr></thead>
              <tbody>
                {names.map((n) => (
                  <tr key={n} className="border-t border-line"><td className="px-5 py-1 font-mono">{n}</td>{d.windows.map((w, i) => { const v = w.features.find((f) => f.feature === n)!.psi; return <td key={i} className="tnum px-1.5 py-1 text-center" style={{ background: psiColor(v) }}>{v.toFixed(3)}</td>; })}</tr>
                ))}
                <tr className="border-t border-line font-medium"><td className="px-5 py-1.5">prediction (risk score)</td>{d.windows.map((w, i) => <td key={i} className="tnum px-1.5 py-1.5 text-center" style={{ background: psiColor(w.prediction_psi) }}>{w.prediction_psi.toFixed(3)}</td>)}</tr>
                <tr className="border-t border-line"><td className="px-5 py-1.5">OOD rate</td>{d.windows.map((w, i) => <td key={i} className="tnum px-1.5 py-1.5 text-center">{pct(w.ood_rate, 1)}</td>)}</tr>
                <tr className="border-t border-line"><td className="px-5 py-1.5">level</td>{d.windows.map((w, i) => <td key={i} className="px-1.5 py-1.5 text-center"><Badge tone={LEVEL_TONE[w.level as keyof typeof LEVEL_TONE]}>{w.level}</Badge></td>)}</tr>
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-5 py-3 text-[12.5px] text-muted">info ≥ 0.10 PSI · warn ≥ 0.25 on a monitored feature or the risk score · critical when OOD ≥ 5% or quality regresses on labelled outcomes.</p>
        </Card>
        <Card>
          <CardHeader title="Behavioural drift by actor" description="Daily mean behavioural-anomaly score (Model B) over 10 days" />
          <ul className="divide-y divide-line">
            {d.behaviour.map((b) => (
              <li key={b.actor_id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0"><div className="truncate text-[13px] font-medium text-ink">{actorName(b.actor_id)}</div><div className="text-[12px] text-muted">latest {b.latest === null ? "—" : b.latest.toFixed(2)} · {b.rise > 0.15 ? <span className="text-high">rising +{b.rise.toFixed(2)}</span> : "stable"}</div></div>
                <Sparkline values={b.daily.map((v) => v ?? 0)} width={120} height={30} accent={b.rise > 0.15 ? "var(--color-high)" : "var(--color-cobalt)"} label={`${actorName(b.actor_id)} anomaly trend`} />
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-5 py-3 text-[12.5px] text-muted">The support copilot’s restricted CRM pulls double every day. No deterministic rule covers read-only lookups; the edge model raised them to <span className="font-medium text-ink">warn</span> and the behaviour score rises with the volume.</p>
        </Card>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader title="Retraining trigger" description="Drift proposes; it never retrains or deploys on its own." />
          <div className="space-y-2 px-5 py-4 text-[13.5px]">
            <div className="flex justify-between"><span className="text-muted">Sustained warn windows</span><span className="tnum">{d.trigger.sustained_windows} / {d.trigger.sustained_required}</span></div>
            <div className="flex justify-between"><span className="text-muted">Labelled outcomes</span><span className="tnum">{d.trigger.labelled_outcomes} / {d.trigger.labels_required}</span></div>
            <div className="flex justify-between"><span className="text-muted">Propose candidate retraining</span><Badge tone={d.trigger.propose_candidate_retraining ? "high" : "neutral"}>{d.trigger.propose_candidate_retraining ? "yes" : "not yet"}</Badge></div>
            <div className="flex justify-between"><span className="text-muted">Auto-promote</span><Badge tone="critical">never</Badge></div>
          </div>
          {off && <p className="border-t border-line px-5 py-3 text-[12.5px] leading-relaxed text-muted">{off.why}</p>}
        </Card>
        {off && (
          <Card>
            <CardHeader title="Offline drill: the Q4 production window" description={`What produced candidate 1.1.0 · ${off.trigger.reason}`} />
            <table className="w-full text-[12.5px]">
              <thead className="text-[11.5px] text-muted"><tr><th className="px-5 py-2 text-left font-medium">Days</th><th className="px-3 py-2 text-right font-medium">n</th><th className="px-3 py-2 text-right font-medium">Max PSI</th><th className="px-3 py-2 text-left font-medium">Top feature</th><th className="px-3 py-2 text-right font-medium">1.0.0 false-esc.</th><th className="px-5 py-2 text-right font-medium">Level</th></tr></thead>
              <tbody>{off.drift_windows.map((w, i) => <tr key={i} className="border-t border-line"><td className="px-5 py-1.5 font-mono">{w.days[0]}–{w.days[1]}</td><td className="tnum px-3 py-1.5 text-right">{w.n.toLocaleString()}</td><td className="tnum px-3 py-1.5 text-right">{w.max_feature_psi.toFixed(3)}</td><td className="px-3 py-1.5 font-mono">{w.top_features[0]?.feature}</td><td className="tnum px-3 py-1.5 text-right">{pct(w.false_escalation_rate_on_window, 2)}</td><td className="px-5 py-1.5 text-right"><Badge tone={LEVEL_TONE[w.level as keyof typeof LEVEL_TONE] ?? "neutral"}>{w.level}</Badge></td></tr>)}</tbody>
            </table>
            <p className={cn("border-t border-line px-5 py-3 text-[12.5px] text-muted")}>Review queue: {off.review_queue.reviewed} of {off.review_queue.queued} queued items labelled within the analyst budget ({off.review_queue.budget}).</p>
          </Card>
        )}
      </div>
    </>
  );
}
