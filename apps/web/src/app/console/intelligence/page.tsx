import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Power, ShieldCheck } from "lucide-react";
import { currentConsoleUser } from "@/lib/server/auth";
import { computeDrift, computeQuality, registryEntry, reviewQueue, roleVersions } from "@/lib/server/ml";
import { PageHeader } from "@/components/console/shell";
import { StatTile } from "@/components/console/stat";
import { StackedColumns } from "@/components/charts";
import { Badge, Card, CardHeader } from "@/components/ui";
import { IntelTabs, RolloutOrbits, StepUpAction } from "@/components/console/intel";
import { pct } from "@/lib/ml-format";
import { RelTime } from "@/components/console/time";
import { cn } from "@/lib/format";

export const metadata: Metadata = { title: "Intelligence" };
export const dynamic = "force-dynamic";

const SERIES = [
  { key: "safe_normal", label: "Safe · normal", color: "var(--color-series-auto)" },
  { key: "safe_unusual", label: "Safe · unusual", color: "#8fb3e8" },
  { key: "suspicious_review", label: "Suspicious", color: "var(--color-series-human)" },
  { key: "high_risk", label: "High risk", color: "var(--color-series-blocked)" },
  { key: "fallback", label: "Fallback (no model)", color: "var(--color-faint)" },
];

export default async function IntelligenceOverview() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const roles = roleVersions(db);
  const prod = roles.production ? registryEntry(roles.production) : undefined;
  const quality = computeQuality(db);
  const drift = computeDrift(db);
  const queue = reviewQueue(db, 0);
  const eps = db.ml.endpoints;
  const onProd = eps.filter((e) => e.model_version === roles.production).length;
  const lastDrift = drift.windows[drift.windows.length - 1];
  const events = db.ml.models.flatMap((m) => m.history).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  const admin = user.roles.some((r) => ["owner", "admin", "policy_admin"].includes(r));
  const t = quality.totals;
  return (
    <>
      <PageHeader
        eyebrow="Endpoint intelligence"
        title="Intelligence"
        description="Edge risk model health, rollout and quality. The model is advisory: deterministic policy decides, the model can only raise an outcome to a human."
        actions={<Link href="/docs#ml" className="text-[13px] font-medium text-cobalt hover:underline">How the model is governed →</Link>}
      />
      <IntelTabs reviewCount={queue.total} />

      {db.ml.kill_switch && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-critical/30 bg-critical-bg px-4 py-3 text-[13.5px] text-critical">
          <Power className="size-4" /> Model kill switch engaged — every decision is deterministic policy only, and endpoints receive a kill-switch manifest.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Release gates (production)" value={prod?.gates?.gates.filter((g) => g.status === "pass").length ?? 0} suffix={`/${prod?.gates?.gates.length ?? 0}`} hint={prod ? `orbis-edge-risk ${roles.production} · ${prod.architecture}` : "no production model"} />
        <StatTile label="Endpoint coverage" value={eps.length ? Math.round((onProd / eps.length) * 100) : 0} suffix="%" hint={`${onProd}/${eps.length} on ${roles.production}`} />
        <StatTile label="Model escalations" value={t.model_escalations} hint="outcomes the model raised" />
        <StatTile label="Abstention rate" value={Math.round(t.abstention_rate * 1000) / 10} suffix="%" hint="uncertain / out of distribution" />
        <StatTile label="Policy ↔ model disagreement" value={Math.round(t.policy_model_disagreement_rate * 1000) / 10} suffix="%" hint="feeds the review queue" />
        <StatTile label="Review queue" value={queue.total} hint={`${t.reviewed} labelled so far`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.35fr]">
        <Card>
          <CardHeader title="Rollout" description="Each dot is an endpoint, placed on the ring of the model it runs." action={<Link href="/console/intelligence/endpoints" className="text-[13px] font-medium text-cobalt hover:underline">Fleet →</Link>} />
          <div className="px-4 pb-4 pt-2">
            <RolloutOrbits endpoints={eps.map((e) => ({ id: e.id, name: e.name, model_version: e.model_version, state: e.state, real: e.real }))} roles={roles} versions={db.ml.models.map((m) => m.version)} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Prediction mix" description={`${t.predictions.toLocaleString()} scored decisions · ${pct(t.fallback_rate)} deterministic fallback · shadow agreement ${t.shadow_agreement ? pct(t.shadow_agreement.agreement) : "—"}`} />
          <div className="px-5 py-4"><StackedColumns height={250} data={quality.days} series={SERIES} label="Daily predictions by class" /></div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Drift" description={`7-day windows vs ${drift.reference.n.toLocaleString()} reference decisions`} action={<Link href="/console/intelligence/drift" className="text-[13px] font-medium text-cobalt hover:underline">Details →</Link>} />
          <div className="space-y-3 px-5 py-4 text-[13.5px]">
            <div className="flex items-center justify-between"><span className="text-muted">Latest window</span><Badge tone={lastDrift?.level === "ok" ? "low" : lastDrift?.level === "info" ? "neutral" : lastDrift?.level === "warn" ? "high" : "critical"}>{lastDrift?.level ?? "—"}</Badge></div>
            <div className="flex items-center justify-between"><span className="text-muted">Max feature PSI</span><span className="tnum font-medium">{lastDrift ? lastDrift.max_feature_psi.toFixed(3) : "—"}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted">Prediction PSI</span><span className="tnum font-medium">{lastDrift ? lastDrift.prediction_psi.toFixed(3) : "—"}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted">OOD rate</span><span className="tnum font-medium">{lastDrift ? pct(lastDrift.ood_rate, 2) : "—"}</span></div>
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">Retraining proposed: <span className="font-medium text-ink">{drift.trigger.propose_candidate_retraining ? "yes" : "no"}</span> — needs {drift.trigger.sustained_required} sustained warn windows and {drift.trigger.labels_required} labels. Never auto-promotes.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Model lifecycle" description="trained → candidate → shadow → canary → production" action={<Link href="/console/intelligence/models" className="text-[13px] font-medium text-cobalt hover:underline">Registry →</Link>} />
          <ol className="divide-y divide-line">
            {events.map((e, i) => (
              <li key={i} className="flex items-start gap-3 px-5 py-2.5 text-[13px]">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", e.reason.startsWith("rolled back") ? "bg-critical" : e.to === "production" ? "bg-low" : e.to === "canary" ? "" : "bg-faint")} style={e.to === "canary" && !e.reason.startsWith("rolled back") ? { background: "var(--color-series-human)" } : undefined} />
                <div className="min-w-0 flex-1">
                  <div className="text-ink"><span className="font-mono">{e.version}</span> → <span className="font-medium">{e.to}</span>{e.percent && e.to === "canary" ? ` ${e.percent}%` : ""}{e.automatic && <Badge tone="high" className="ml-1.5">automatic</Badge>}</div>
                  <div className="truncate text-[12px] text-muted">{e.reason} · {e.by}</div>
                </div>
                <RelTime iso={e.at} className="shrink-0 text-[12px] text-faint" />
              </li>
            ))}
          </ol>
        </Card>
        <Card>
          <CardHeader title="Fusion & emergency controls" description="How the model may affect outcomes for this tenant" />
          <div className="space-y-3 px-5 py-4 text-[13.5px]">
            <div className="flex items-center justify-between"><span className="text-muted">Mode</span><Badge tone={db.ml.fusion.mode === "escalate" ? "cobalt" : "neutral"}>{db.ml.fusion.mode}</Badge></div>
            <div className="flex items-center justify-between"><span className="text-muted">Raises to approval</span><span>{db.ml.fusion.approval_classes.join(", ").replace(/_/g, " ")}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted">Raises to warn</span><span>{db.ml.fusion.warn_classes.join(", ").replace(/_/g, " ")}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted">Abstain + high impact</span><span>{db.ml.fusion.escalate_abstain_high_impact ? "→ human" : "policy only"}</span></div>
            <div className="flex flex-wrap gap-2 pt-1">
              {(["escalate", "advisory"] as const).filter((m) => m !== db.ml.fusion.mode).map((m) => (
                <StepUpAction key={m} label={m === "advisory" ? "Switch to advisory" : "Enable escalation"} title={`Set model fusion to ${m}?`} body={m === "advisory" ? "The model will be recorded and shown to reviewers but can no longer change any outcome." : "The model may raise allow/warn outcomes to a human (never lower them)."} path="/api/v1/ml/settings" json={{ mode: m }} disabled={!admin} disabledReason="Admin only" icon={<ShieldCheck className="size-4" />} />
              ))}
              <StepUpAction label={db.ml.kill_switch ? "Release kill switch" : "Kill switch"} variant={db.ml.kill_switch ? "secondary" : "danger"} title={db.ml.kill_switch ? "Release the model kill switch?" : "Engage the model kill switch?"} body={db.ml.kill_switch ? "Model scoring resumes; endpoints receive a fresh manifest." : "All decisions immediately fall back to deterministic policy, and every endpoint receives a signed kill-switch manifest."} path="/api/v1/ml/settings" json={{ kill_switch: !db.ml.kill_switch }} icon={<Power className="size-4" />} />
            </div>
            <Link href="/console/audit" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">Every change is audit-chained <ArrowRight className="size-3" /></Link>
          </div>
        </Card>
      </div>
    </>
  );
}
