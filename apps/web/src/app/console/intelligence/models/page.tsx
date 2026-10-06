import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, RotateCcw, Rocket } from "lucide-react";
import { currentConsoleUser } from "@/lib/server/auth";
import { modelsView } from "@/lib/server/ml-api";
import { REGISTRY, reviewQueue } from "@/lib/server/ml";
import { PageHeader } from "@/components/console/shell";
import { Badge, Card, CardHeader } from "@/components/ui";
import { IntelTabs, StepUpAction } from "@/components/console/intel";
import { pct } from "@/lib/ml-format";
import { cn } from "@/lib/format";

export const metadata: Metadata = { title: "Models · Intelligence" };
export const dynamic = "force-dynamic";

type V = ReturnType<typeof modelsView>["versions"][number];
const STATUS_TONE: Record<string, "low" | "cobalt" | "neutral" | "high" | "critical"> = { production: "low", canary: "high", shadow: "cobalt", candidate: "cobalt", deprecated: "neutral", rejected: "critical", retired: "neutral" };

function Actions({ v, admin }: { v: V; admin: boolean }) {
  const failing = v.gates?.gates.filter((g) => g.status !== "pass").length ?? null;
  const gated = v.gates?.status === "pass";
  const why = !v.gates ? "No release-gate report for this version" : `${failing} release gate${failing === 1 ? "" : "s"} not passing`;
  const p = (to: string, percent?: number) => ({ path: `/api/v1/ml/models/${v.version}/promote`, json: { to, percent, reason: `${to}${percent ? ` ${percent}%` : ""} from console` } });
  const promote = (label: string, to: string, percent?: number) => (
    <StepUpAction label={label} title={`Move ${v.version} to ${to}${percent ? ` ${percent}%` : ""}?`} body={to === "production" ? "Every endpoint will receive a signed manifest for this version; the previous production model is kept for rollback." : to === "canary" ? `Endpoints whose bucket is under ${percent}% switch to ${v.version}. The health monitor rolls back automatically on a latency or failure breach.` : "The model scores live traffic in shadow — recorded for comparison, never used for decisions."} {...p(to, percent)} disabled={!admin || !gated} disabledReason={!admin ? "Admin only" : why} variant={to === "production" ? "primary" : "secondary"} icon={<Rocket className="size-3.5" />} />
  );
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {v.status === "candidate" && promote("Shadow", "shadow")}
      {v.status === "shadow" && promote("Canary 5%", "canary", 5)}
      {v.status === "canary" && v.rollout_percent < 25 && promote("Canary 25%", "canary", 25)}
      {v.status === "canary" && promote("Production", "production")}
      {["production", "canary", "shadow"].includes(v.status) && (
        <StepUpAction label="Roll back" title={`Roll back ${v.version}?`} body="The previous production model becomes active again and endpoints receive a new signed manifest (higher sequence number, so it cannot be replayed)." path={`/api/v1/ml/models/${v.version}/rollback`} json={{ reason: "manual rollback from console" }} variant="danger" icon={<RotateCcw className="size-3.5" />} />
      )}
      {v.status === "candidate" && !gated && <span className="self-center text-[12px] text-critical">{why}</span>}
    </div>
  );
}

export default async function ModelsPage() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const view = modelsView(db);
  const admin = user.roles.some((r) => ["owner", "admin", "policy_admin"].includes(r));
  const prod = view.versions.find((v) => v.role === "production");
  const cand = view.versions.find((v) => v.status === "candidate") ?? view.versions.find((v) => v.status === "shadow" || v.status === "canary");
  const base = REGISTRY.baselines as unknown as { selection_rule: string; selected: string; models: Array<Record<string, number | string | boolean | null>> };
  const rows: Array<[string, string, (v: V) => number | null | undefined, "up" | "down", number]> = [
    ["Test · mean security cost", "test", (v) => v.metrics?.test.mean_cost, "down", 4],
    ["Test · high-risk escalation recall", "test", (v) => v.metrics?.test.high_risk_escalation_recall, "up", 1],
    ["Test · suspicious+high recall", "test", (v) => v.metrics?.test.risky_escalation_recall, "up", 1],
    ["Test · false-escalation rate", "test", (v) => v.metrics?.test.false_escalation_rate, "down", 2],
    ["Test · ECE", "test", (v) => v.metrics?.test.ece, "down", 4],
    ["Gold · suspicious+high recall", "gold", (v) => v.metrics?.gold.risky_escalation_recall, "up", 1],
    ["Gold · hard-negative FPR", "gold", (v) => v.metrics?.gold.hard_negative_false_positive_rate, "down", 1],
    ["Q4 window · mean cost", "window", (v) => (v.metrics as { window_holdout?: { mean_cost: number } } | null)?.window_holdout?.mean_cost ?? (v.version === prod?.version ? cand?.comparison?.window_holdout.mean_cost?.production : undefined), "down", 4],
    ["Q4 window · suspicious+high recall", "window", (v) => (v.metrics as { window_holdout?: { risky_escalation_recall: number } } | null)?.window_holdout?.risky_escalation_recall ?? (v.version === prod?.version ? cand?.comparison?.window_holdout.risky_escalation_recall?.production : undefined), "up", 1],
  ];
  const fmt = (label: string, v: number | null | undefined, d: number) => (v === null || v === undefined ? "—" : label.includes("cost") || label.includes("ECE") ? v.toFixed(d) : pct(v, d));
  return (
    <>
      <PageHeader eyebrow="Model registry" title="Models" description="Every version with its lineage, release gates, parity and measured endpoint benchmarks. Only versions that pass every gate can be deployed; retraining never auto-promotes." />
      <IntelTabs reviewCount={reviewQueue(db, 0).total} />
      <Card>
        <CardHeader title="orbis-edge-risk" description={`Manifest sequence ${view.manifest_seq} · feature schema ${view.feature_schema} · fusion ${view.fusion.mode}${view.kill_switch ? " · KILL SWITCH ON" : ""}`} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-[13px]">
            <thead className="border-b border-line bg-surface-2 text-[12px] text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Version</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Model · origin</th>
                <th className="px-3 py-2.5 text-right font-medium">Test cost</th>
                <th className="px-3 py-2.5 text-right font-medium">Risky recall</th>
                <th className="px-3 py-2.5 text-right font-medium">False-esc.</th>
                <th className="px-3 py-2.5 font-medium">Gates</th>
                <th className="px-3 py-2.5 text-right font-medium">Endpoints</th>
                <th className="px-5 py-2.5 text-right font-medium">Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {[...view.versions].reverse().map((v) => {
                const passed = v.gates?.gates.filter((g) => g.status === "pass").length;
                return (
                  <tr key={v.version} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <td className="px-5 py-3"><Link href={`/console/intelligence/models/${v.version}`} className="inline-flex items-center gap-1 font-mono font-semibold text-ink hover:text-cobalt">{v.version}<ArrowUpRight className="size-3.5" /></Link></td>
                    <td className="px-3 py-3"><Badge tone={STATUS_TONE[v.status] ?? "neutral"}>{v.status}{v.status === "canary" ? ` ${v.rollout_percent}%` : ""}</Badge></td>
                    <td className="px-3 py-3"><div className="text-ink">{v.architecture}</div><div className="text-[12px] text-muted">{v.origin}</div></td>
                    <td className="tnum px-3 py-3 text-right">{v.metrics?.test.mean_cost?.toFixed(4) ?? "—"}</td>
                    <td className="tnum px-3 py-3 text-right">{pct(v.metrics?.test.risky_escalation_recall)}</td>
                    <td className="tnum px-3 py-3 text-right">{pct(v.metrics?.test.false_escalation_rate, 2)}</td>
                    <td className="px-3 py-3">{v.gates ? <span className={cn("font-medium", v.gates.status === "pass" ? "text-low" : "text-critical")}>{passed}/{v.gates.gates.length} {v.gates.status}</span> : <span className="text-faint">pre-gate era</span>}</td>
                    <td className="tnum px-3 py-3 text-right">{v.endpoints}</td>
                    <td className="px-5 py-3"><Actions v={v} admin={admin} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {prod && cand && (
        <Card className="mt-4">
          <CardHeader title={`Candidate ${cand.version} vs production ${prod.version}`} description="Same immutable test split and gold set; the Q4 window is fresh production-shaped traffic neither model trained on." />
          <div className="grid gap-0 lg:grid-cols-[1.4fr_1fr]">
            <table className="w-full text-[13px]">
              <thead className="text-[12px] text-muted"><tr><th className="px-5 py-2 text-left font-medium">Metric</th><th className="px-3 py-2 text-right font-medium">{prod.version}</th><th className="px-3 py-2 text-right font-medium">{cand.version}</th><th className="px-5 py-2 text-right font-medium">Δ</th></tr></thead>
              <tbody>
                {rows.map(([label, , get, good, d]) => {
                  const a = get(prod), b = get(cand);
                  const better = a !== null && a !== undefined && b !== null && b !== undefined ? (good === "up" ? b > a + 1e-9 : b < a - 1e-9) : null;
                  const worse = a !== null && a !== undefined && b !== null && b !== undefined ? (good === "up" ? b < a - 1e-9 : b > a + 1e-9) : null;
                  return (
                    <tr key={label} className="border-t border-line">
                      <td className="px-5 py-2 text-ink-2">{label}</td>
                      <td className="tnum px-3 py-2 text-right">{fmt(label, a, d)}</td>
                      <td className="tnum px-3 py-2 text-right font-medium">{fmt(label, b, d)}</td>
                      <td className={cn("tnum px-5 py-2 text-right text-[12px]", better ? "text-low" : worse ? "text-critical" : "text-faint")}>{better ? "better" : worse ? "worse" : "same"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="border-t border-line px-5 py-4 lg:border-l lg:border-t-0">
              <div className="text-[13px] font-semibold text-ink">Release decision</div>
              <p className="mt-1 text-[13px] text-muted">{cand.gates?.status === "pass" ? "Every gate passes — eligible for shadow." : "Blocked. The candidate fixes the red-team finding (asserted-ticket refunds) and is far better on the Q4 window, but it regresses a golden scenario and a protected slice. Investigate before any shadow run."}</p>
              <ul className="mt-3 space-y-1.5">
                {cand.gates?.gates.filter((g) => g.status !== "pass").map((g) => (
                  <li key={g.name} className="rounded-lg bg-critical-bg px-3 py-2 text-[12.5px] text-critical"><span className="font-semibold">{g.name.replace(/_/g, " ")}</span> · {typeof g.observed === "object" ? JSON.stringify(g.observed).replace(/[{}"]/g, "").replace(/,/g, ", ") : String(g.observed)}</li>
                ))}
              </ul>
              <Link href={`/console/intelligence/models/${cand.version}`} className="mt-3 inline-flex text-[13px] font-medium text-cobalt hover:underline">Open the {cand.version} passport →</Link>
            </div>
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader title="Baselines before the edge model" description={base.selection_rule} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13px]">
            <thead className="border-b border-line bg-surface-2 text-[12px] text-muted">
              <tr><th className="px-5 py-2 text-left font-medium">Model</th><th className="px-3 py-2 text-left font-medium">Portable</th><th className="px-3 py-2 text-right font-medium">Params</th><th className="px-3 py-2 text-right font-medium">Val cost</th><th className="px-3 py-2 text-right font-medium">Test cost</th><th className="px-3 py-2 text-right font-medium">Macro-F1</th><th className="px-3 py-2 text-right font-medium">Risky recall</th><th className="px-3 py-2 text-right font-medium">False-esc.</th><th className="px-5 py-2 text-right font-medium">ECE</th></tr>
            </thead>
            <tbody>
              {base.models.map((m) => (
                <tr key={String(m.name)} className={cn("border-b border-line last:border-0", m.name === base.selected && "bg-cobalt-50/50")}>
                  <td className="px-5 py-2 font-mono">{String(m.name)}{m.name === base.selected && <Badge tone="cobalt" className="ml-2">selected</Badge>}</td>
                  <td className="px-3 py-2">{m.portable ? "Core ML · ONNX · TS · Swift" : m.name === "rule" ? <span className="text-muted">hand-weighted rules</span> : <span className="text-muted">no Core ML/ONNX path</span>}</td>
                  <td className="tnum px-3 py-2 text-right">{m.n_params ?? "—"}</td>
                  <td className="tnum px-3 py-2 text-right">{Number(m.val_mean_cost).toFixed(4)}</td>
                  <td className="tnum px-3 py-2 text-right">{Number(m.test_mean_cost).toFixed(4)}</td>
                  <td className="tnum px-3 py-2 text-right">{Number(m.test_macro_f1).toFixed(3)}</td>
                  <td className="tnum px-3 py-2 text-right">{pct(Number(m.test_risky_escalation_recall))}</td>
                  <td className="tnum px-3 py-2 text-right">{pct(Number(m.test_false_escalation_rate), 2)}</td>
                  <td className="tnum px-5 py-2 text-right">{m.test_ece === null ? "—" : Number(m.test_ece).toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
