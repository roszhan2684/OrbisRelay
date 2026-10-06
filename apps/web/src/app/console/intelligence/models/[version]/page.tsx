import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentConsoleUser } from "@/lib/server/auth";
import { modelView } from "@/lib/server/ml-api";
import { reviewQueue, signedManifest } from "@/lib/server/ml";
import { PageHeader } from "@/components/console/shell";
import { Badge, Card, CardHeader } from "@/components/ui";
import { GateRow, IntelTabs, Markdown } from "@/components/console/intel";
import { pct } from "@/lib/ml-format";
import { ManifestVerifier } from "@/components/console/manifest-verifier";
import { RelTime } from "@/components/console/time";
import cards from "@/lib/ml/edge/cards.json";

const CARDS = cards as Record<string, string>;
export const metadata: Metadata = { title: "Model passport · Intelligence" };
export const dynamic = "force-dynamic";

export default async function ModelPassport({ params }: PageProps<"/console/intelligence/models/[version]">) {
  const { version } = await params;
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const m = db.ml.models.find((x) => x.version === version);
  if (!m) notFound();
  const v = modelView(db, m);
  const deployed = ["production", "canary", "shadow"].includes(m.status);
  const sample = db.ml.endpoints.find((e) => e.model_version === version && e.state === "healthy") ?? db.ml.endpoints[0];
  const manifest = deployed && sample ? signedManifest(db, { ...sample, bucket: m.status === "canary" ? 0 : 99 }) : null;
  const b = v.benchmark;
  return (
    <>
      <PageHeader eyebrow="Model passport" title={`orbis-edge-risk ${version}`} description={`${v.architecture} · ${v.n_params?.toLocaleString()} parameters · ${v.origin}`} actions={<Badge tone={m.status === "production" ? "low" : m.status === "candidate" ? "cobalt" : "neutral"}>{m.status}{m.status === "canary" ? ` ${m.rollout_percent}%` : ""}</Badge>} />
      <IntelTabs reviewCount={reviewQueue(db, 0).total} />
      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <Card>
          <CardHeader title={`Release gates · ${v.gates?.status ?? "no report"}`} description={v.gates?.baseline ? `Slice regressions checked against ${v.gates.baseline}` : "Machine-readable release_gate_report.json; CI blocks promotion on any failure."} />
          <ul>{v.gates ? v.gates.gates.map((g) => <GateRow key={g.name} g={g} />) : <li className="px-5 py-4 text-[13px] text-muted">This version predates release gates (logistic-regression baseline, kept as a rollback target).</li>}</ul>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Signed distribution manifest" description={manifest ? "What an endpoint downloads. Verified here with WebCrypto, on the endpoint with CryptoKit." : "Only shadow, canary and production versions are distributable."} />
            <div className="px-5 py-4">
              {manifest ? <ManifestVerifier manifest={manifest} publicKeyX={db.ml.signing_key.x} /> : <p className="text-[13px] text-muted">Artifact sha256 <span className="font-mono">{String((v.artifacts as { coreml_fp32_zip?: { sha256: string } } | null)?.coreml_fp32_zip?.sha256 ?? "—").slice(0, 24)}…</span> · portable weights <span className="font-mono">{String(v.artifacts?.portable_sha256 ?? "").slice(0, 16)}…</span></p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Runtime parity" description="Max |Δ probability| vs the float64 Python reference" />
            <table className="w-full text-[13px]">
              <tbody>
                {v.parity ? Object.entries(v.parity).map(([k, p]) => (
                  <tr key={k} className="border-b border-line last:border-0"><td className="px-5 py-2 font-mono text-[12.5px]">{k}</td><td className="tnum px-3 py-2 text-right">{p.max_abs_probability_delta.toExponential(1)}</td><td className="tnum px-3 py-2 text-right">{(p.bytes / 1024).toFixed(1)} KB</td><td className="px-5 py-2 text-right"><Badge tone={p.passed ? "low" : "critical"}>{p.passed ? "pass" : "fail"}</Badge></td></tr>
                )) : <tr><td className="px-5 py-3 text-muted">No conversion report.</td></tr>}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Measured on Apple silicon" description={b ? `${b.device.cpu} · ${b.runtime} · ${b.compute_units}` : "No benchmark yet"} />
          {b && (
            <dl className="grid grid-cols-2 gap-px bg-line text-[13px]">
              {[
                ["Warm p50", `${b.warm_us.p50.toFixed(1)} µs`], ["Warm p95", `${b.warm_us.p95.toFixed(1)} µs`], ["Pipeline p95", `${b.pipeline_us.p95.toFixed(1)} µs`], ["Cold load", `${b.cold_ms.toFixed(1)} ms`],
                ["Model memory", `+${b.memory_mb.model_load_delta.toFixed(1)} MB`], ["Peak footprint", `${b.memory_mb.peak_footprint.toFixed(1)} MB`], ["Idle CPU", `${b.idle_cpu_percent.toFixed(3)}%`], ["CPU / 1k inf.", `${b.cpu_ms_per_1k.toFixed(1)} ms`],
              ].map(([k, val]) => <div key={k} className="bg-surface px-4 py-2.5"><dt className="text-[11.5px] text-muted">{k}</dt><dd className="tnum font-semibold text-ink">{val}</dd></div>)}
            </dl>
          )}
          <p className="px-5 py-3 text-[12px] text-faint">Energy not measured (needs powermetrics/Instruments); CPU time is the proxy. Source: <span className="font-mono">{b?.source.split("/").slice(-2).join("/")}</span></p>
        </Card>
        <Card>
          <CardHeader title="Lineage" description="Reproducible from dataset manifest + commit + config" />
          <dl className="space-y-1.5 px-5 py-4 text-[13px]">
            {[["Dataset", v.dataset], ["Trained", v.trained_at ? new Date(v.trained_at).toUTCString().slice(5, 22) : "—"], ["Git", v.reproducibility ? "see training_run.json" : "—"], ["MLflow run", v.mlflow_run_id?.slice(0, 12)], ["Reproduced", v.reproducibility ? (v.reproducibility.passed ? `yes · weights bit-identical: ${v.reproducibility.weights_bit_identical}` : "no") : "—"], ["Test risky recall", pct(v.metrics?.test.risky_escalation_recall)], ["Gold risky recall", pct(v.metrics?.gold.risky_escalation_recall)]].map(([k, val]) => (
              <div key={String(k)} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="truncate font-mono text-[12.5px] text-ink-2">{val ?? "—"}</dd></div>
            ))}
          </dl>
          <div className="border-t border-line px-5 py-3 text-[12.5px]"><Link href={`/console/intelligence/evaluation?v=${version}`} className="font-medium text-cobalt hover:underline">Evaluation detail →</Link></div>
        </Card>
        <Card>
          <CardHeader title="Lifecycle" />
          <ol className="divide-y divide-line">
            {[...m.history].reverse().map((h, i) => (
              <li key={i} className="px-5 py-2.5 text-[13px]"><div className="flex justify-between"><span className="font-medium">{h.to}{h.percent && h.to === "canary" ? ` ${h.percent}%` : ""}</span><RelTime iso={h.at} className="text-[12px] text-faint" /></div><div className="text-[12px] text-muted">{h.reason} · {h.by}</div></li>
            ))}
          </ol>
        </Card>
      </div>
      {CARDS[version] && (
        <Card className="mt-4">
          <div className="px-6 py-5"><Markdown text={CARDS[version]} /></div>
        </Card>
      )}
    </>
  );
}
