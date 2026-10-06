import type { Metadata } from "next";
import Link from "next/link";
import { currentConsoleUser } from "@/lib/server/auth";
import { reviewQueue, roleVersions } from "@/lib/server/ml";
import { PageHeader } from "@/components/console/shell";
import { StatTile } from "@/components/console/stat";
import { Badge, Card, CardHeader } from "@/components/ui";
import { ConfusionMatrix, IntelTabs, ThresholdScrubber, type SweepRow } from "@/components/console/intel";
import { LABEL_TEXT, pct } from "@/lib/ml-format";
import { cn } from "@/lib/format";
import e090 from "@/lib/ml/edge/eval/0.9.0.json";
import e100 from "@/lib/ml/edge/eval/1.0.0.json";
import e110 from "@/lib/ml/edge/eval/1.1.0.json";

export const metadata: Metadata = { title: "Evaluation · Intelligence" };
export const dynamic = "force-dynamic";

type Summary = { mean_cost: number; macro_f1: number; high_risk_escalation_recall: number; risky_escalation_recall: number; false_escalation_rate: number; safe_precision: number; ece: number; brier: number; risky_pr_auc: number; risky_roc_auc: number; abstention_rate: number; n: number };
type Slice = { n: number; risky: number; risky_escalation_recall: number | null; false_escalation_rate: number | null; mean_cost: number };
interface Eval {
  version: string;
  val: Summary;
  test: Summary & { confusion_matrix: number[][]; per_class: Record<string, { precision: number; recall: number; f1: number; support: number }>; reliability_risky: Array<{ mean_predicted: number; observed: number; n: number }> };
  gold: { n: number; high_risk_escalation_recall: number; risky_escalation_recall: number; hard_negative_false_positive_rate: number; scenarios: Array<{ id: string; title: string; expect: string; predicted: string; risk: number; correct_escalation: boolean; known_limitation: boolean; tags: string[]; abstain: boolean }> };
  slices: Record<string, Slice>;
  threshold_sweep: { fixed_tau_high: SweepRow[]; fixed_tau_review: SweepRow[] };
  calibration_comparison: { none: { ece: number; brier: number }; temperature: { T: number; ece: number; brier: number }; isotonic_ovr: { ece: number; brier: number } } | null;
  window_holdout: Summary | null;
  policy: { temperature: number; tau_high: number; tau_review: number; abstain_entropy: number; version: string };
  adversarial: { summary: { required_passed: number; required_total: number }; cases: Array<{ name: string; category: string; required: boolean; status: string; expected: string }> } | null;
  anomaly: { positives: number; negatives: number; robust_median_mad: { roc_auc: number; pr_auc: number }; isolation_forest: { roc_auc: number; pr_auc: number }; fusion: { adopt_auto_escalation: boolean; model_a_only: Record<string, number>; model_a_or_anomaly: Record<string, number> } } | null;
}
const EVALS: Record<string, Eval> = { "0.9.0": e090 as unknown as Eval, "1.0.0": e100 as unknown as Eval, "1.1.0": e110 as unknown as Eval };

function Reliability({ bins }: { bins: Eval["test"]["reliability_risky"] }) {
  const S = 220;
  return (
    <svg viewBox={`-28 -8 ${S + 40} ${S + 36}`} className="w-full max-w-[300px]" role="img" aria-label="Reliability diagram for the risky score">
      <rect x={0} y={0} width={S} height={S} fill="var(--color-surface-2)" rx={6} />
      <line x1={0} y1={S} x2={S} y2={0} stroke="var(--color-faint)" strokeDasharray="4 4" />
      {bins.map((b, i) => <circle key={i} cx={b.mean_predicted * S} cy={S - b.observed * S} r={Math.max(3, Math.min(11, Math.sqrt(b.n) / 3))} fill="var(--color-cobalt)" opacity={0.75}><title>{`predicted ${b.mean_predicted.toFixed(2)} · observed ${b.observed.toFixed(2)} · n ${b.n}`}</title></circle>)}
      <text x={S / 2} y={S + 22} textAnchor="middle" fontSize={10} fill="var(--color-muted)">predicted P(suspicious)+P(high)</text>
      <text x={-18} y={S / 2} textAnchor="middle" fontSize={10} fill="var(--color-muted)" transform={`rotate(-90 -18 ${S / 2})`}>observed risky rate</text>
    </svg>
  );
}

export default async function EvaluationPage({ searchParams }: PageProps<"/console/intelligence/evaluation">) {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const sp = await searchParams;
  const prod = roleVersions(db).production ?? "1.0.0";
  const version = typeof sp.v === "string" && EVALS[sp.v] ? sp.v : prod;
  const e = EVALS[version];
  const t = e.test;
  const sliceRows = Object.entries(e.slices).filter(([, s]) => s.n >= 20);
  return (
    <>
      <PageHeader
        eyebrow="Offline evaluation"
        title="Evaluation"
        description="Held-out test split (unseen days, held-out actor instances and template variants) plus the hand-authored gold security set. Accuracy is never the headline: security cost, escalation recall and false escalations are."
        actions={
          <div className="inline-flex rounded-[10px] bg-surface-2 p-0.5 ring-1 ring-inset ring-line">
            {Object.keys(EVALS).map((v) => <Link key={v} href={`/console/intelligence/evaluation?v=${v}`} className={cn("rounded-[8px] px-3 py-1.5 font-mono text-[12.5px]", v === version ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>{v}</Link>)}
          </div>
        }
      />
      <IntelTabs reviewCount={reviewQueue(db, 0).total} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Mean security cost" value={Math.round(t.mean_cost * 10000) / 10000} format={{ minimumFractionDigits: 4 }} hint={`val ${e.val.mean_cost.toFixed(4)}`} />
        <StatTile label="Suspicious+high recall" value={Math.round(t.risky_escalation_recall * 1000) / 10} suffix="%" hint={`gold ${pct(e.gold.risky_escalation_recall)}`} />
        <StatTile label="High-risk recall" value={Math.round(t.high_risk_escalation_recall * 1000) / 10} suffix="%" hint={`gold ${pct(e.gold.high_risk_escalation_recall)}`} />
        <StatTile label="False-escalation rate" value={Math.round(t.false_escalation_rate * 10000) / 100} suffix="%" hint={`gold hard-neg ${pct(e.gold.hard_negative_false_positive_rate)}`} />
        <StatTile label="Macro-F1" value={Math.round(t.macro_f1 * 1000) / 1000} format={{ minimumFractionDigits: 3 }} hint={`risky PR-AUC ${t.risky_pr_auc?.toFixed(3)}`} />
        <StatTile label="ECE" value={Math.round(t.ece * 10000) / 10000} format={{ minimumFractionDigits: 4 }} hint={`T = ${e.policy.temperature}`} />
      </div>

      <Card className="mt-4">
        <CardHeader title="Threshold explorer" description={`Operating point τ_review ${e.policy.tau_review} · τ_high ${e.policy.tau_high} (policy ${e.policy.version}). Drag to see the confusion matrix, cost and gate status move.`} />
        <div className="px-5 py-5"><ThresholdScrubber byReview={e.threshold_sweep.fixed_tau_high} byHigh={e.threshold_sweep.fixed_tau_review} chosen={{ tau_review: e.policy.tau_review, tau_high: e.policy.tau_high }} /></div>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader title="Per class (test)" description={`${t.n.toLocaleString()} events · intentionally imbalanced`} />
          <table className="w-full text-[13px]">
            <thead className="text-[12px] text-muted"><tr><th className="px-5 py-2 text-left font-medium">Class</th><th className="px-3 py-2 text-right font-medium">Precision</th><th className="px-3 py-2 text-right font-medium">Recall</th><th className="px-3 py-2 text-right font-medium">F1</th><th className="px-5 py-2 text-right font-medium">Support</th></tr></thead>
            <tbody>{Object.entries(t.per_class).map(([k, v]) => <tr key={k} className="border-t border-line"><td className="px-5 py-2">{LABEL_TEXT[k]}</td><td className="tnum px-3 py-2 text-right">{v.precision.toFixed(3)}</td><td className="tnum px-3 py-2 text-right">{v.recall.toFixed(3)}</td><td className="tnum px-3 py-2 text-right">{v.f1.toFixed(3)}</td><td className="tnum px-5 py-2 text-right">{v.support.toLocaleString()}</td></tr>)}</tbody>
          </table>
          <div className="border-t border-line px-5 py-4"><ConfusionMatrix cm={t.confusion_matrix} /></div>
        </Card>
        <Card>
          <CardHeader title="Calibration" description="Does a 0.9 risk mean 0.9? Temperature scaling is versioned separately from the weights." />
          <div className="grid items-center gap-4 px-5 py-4 sm:grid-cols-[auto_1fr]">
            <Reliability bins={t.reliability_risky} />
            {e.calibration_comparison && (
              <table className="text-[13px]">
                <thead className="text-[12px] text-muted"><tr><th className="py-1 pr-4 text-left font-medium">Method</th><th className="py-1 pr-4 text-right font-medium">ECE</th><th className="py-1 text-right font-medium">Brier</th></tr></thead>
                <tbody>
                  <tr><td className="py-1 pr-4">None</td><td className="tnum pr-4 text-right">{e.calibration_comparison.none.ece.toFixed(4)}</td><td className="tnum text-right">{e.calibration_comparison.none.brier.toFixed(4)}</td></tr>
                  <tr className="font-semibold"><td className="py-1 pr-4">Temperature (shipped)</td><td className="tnum pr-4 text-right">{e.calibration_comparison.temperature.ece.toFixed(4)}</td><td className="tnum text-right">{e.calibration_comparison.temperature.brier.toFixed(4)}</td></tr>
                  <tr><td className="py-1 pr-4">Isotonic (OvR)</td><td className="tnum pr-4 text-right">{e.calibration_comparison.isotonic_ovr.ece.toFixed(4)}</td><td className="tnum text-right">{e.calibration_comparison.isotonic_ovr.brier.toFixed(4)}</td></tr>
                </tbody>
              </table>
            )}
          </div>
          <p className="border-t border-line px-5 py-3 text-[12.5px] text-muted">Abstention: unknown schema fields or normalised entropy ≥ {e.policy.abstain_entropy}. Abstained high-impact actions go to a human. Test abstention rate {pct(t.abstention_rate, 2)}.</p>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Slices (test)" description="Required slices from the blueprint; protected slices may not regress more than 2% between versions." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="border-b border-line bg-surface-2 text-[12px] text-muted"><tr><th className="px-5 py-2 text-left font-medium">Slice</th><th className="px-3 py-2 text-right font-medium">n</th><th className="px-3 py-2 text-right font-medium">Risky</th><th className="w-[28%] px-3 py-2 text-left font-medium">Escalation recall</th><th className="px-3 py-2 text-right font-medium">False-esc.</th><th className="px-5 py-2 text-right font-medium">Cost</th></tr></thead>
            <tbody>
              {sliceRows.map(([k, s]) => (
                <tr key={k} className="border-b border-line last:border-0">
                  <td className="px-5 py-1.5 font-mono text-[12.5px]">{k}</td>
                  <td className="tnum px-3 py-1.5 text-right">{s.n.toLocaleString()}</td>
                  <td className="tnum px-3 py-1.5 text-right">{s.risky}</td>
                  <td className="px-3 py-1.5">{s.risky_escalation_recall === null ? <span className="text-faint">no risky events</span> : <div className="flex items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-surface-2"><div className="h-1.5 rounded-full" style={{ width: `${s.risky_escalation_recall * 100}%`, background: s.risky_escalation_recall >= 0.94 ? "var(--color-low)" : "var(--color-high)" }} /></div><span className="tnum w-12 text-right">{pct(s.risky_escalation_recall)}</span></div>}</td>
                  <td className="tnum px-3 py-1.5 text-right">{pct(s.false_escalation_rate, 2)}</td>
                  <td className="tnum px-5 py-1.5 text-right">{s.mean_cost.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title={`Gold security set · ${e.gold.scenarios.filter((s) => !s.known_limitation && s.correct_escalation).length}/${e.gold.n} correct`} description="Hand-authored scenarios, immutable (hash pinned in the dataset manifest), used only by release gates." />
          <div className="grid max-h-[560px] gap-1 overflow-y-auto px-5 py-4 sm:grid-cols-2">
            {e.gold.scenarios.map((s) => (
              <div key={s.id} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[12px]", s.known_limitation ? "border-dashed border-medium/40 bg-medium-bg/40" : s.correct_escalation ? "border-line" : "border-critical/40 bg-critical-bg/60")} title={`expected ${s.expect} · predicted ${s.predicted} · risk ${s.risk}`}>
                <span className={cn("size-2 shrink-0 rounded-full", s.known_limitation ? "bg-medium" : s.correct_escalation ? "bg-low" : "bg-critical")} />
                <span className="min-w-0 truncate"><span className="font-mono text-faint">{s.id}</span> <span className="text-ink-2">{s.title}</span>{s.known_limitation && <span className="text-medium"> · known limitation</span>}</span>
              </div>
            ))}
          </div>
        </Card>
        <div className="space-y-4">
          {e.adversarial && (
            <Card>
              <CardHeader title={`Adversarial suite · ${e.adversarial.summary.required_passed}/${e.adversarial.summary.required_total} required`} description="Evasion, poisoning, OOD and prompt-text cases. Attacks that succeed are documented, not hidden." />
              <ul className="divide-y divide-line">
                {e.adversarial.cases.map((c) => (
                  <li key={c.name} className="flex items-start justify-between gap-3 px-5 py-2 text-[12.5px]">
                    <span className="text-ink-2">{c.name} <span className="text-faint">· {c.category}</span></span>
                    <Badge tone={c.status === "pass" ? "low" : c.status === "FAIL" ? "critical" : "medium"}>{c.status === "documented_limitation" ? "limitation" : c.status}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {e.anomaly && (
            <Card>
              <CardHeader title="Model B · behavioural anomaly" description={`${e.anomaly.positives} behavioural attacks vs ${e.anomaly.negatives.toLocaleString()} safe events`} />
              <div className="space-y-2 px-5 py-4 text-[13px]">
                <div className="flex justify-between"><span className="text-muted">Robust median/MAD (per actor, shipped)</span><span className="tnum">ROC {e.anomaly.robust_median_mad.roc_auc.toFixed(3)} · PR {e.anomaly.robust_median_mad.pr_auc.toFixed(3)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Isolation Forest (global, offline)</span><span className="tnum">ROC {e.anomaly.isolation_forest.roc_auc.toFixed(3)} · PR {e.anomaly.isolation_forest.pr_auc.toFixed(3)}</span></div>
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">Auto-escalation on anomaly: <span className="font-medium text-ink">{e.anomaly.fusion.adopt_auto_escalation ? "adopted" : "not adopted"}</span> — it added no recall over Model A on the test split while raising false escalations, so the score is shown to reviewers instead.</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
