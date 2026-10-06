import type { Metadata } from "next";
import { Activity, Laptop, Server, Workflow } from "lucide-react";
import { currentConsoleUser } from "@/lib/server/auth";
import { assignedVersion, REGISTRY, reviewQueue, roleVersions } from "@/lib/server/ml";
import { DEMO_KEYS } from "@/lib/server/seed";
import { PageHeader } from "@/components/console/shell";
import { StatTile } from "@/components/console/stat";
import { Badge, Card, CardHeader } from "@/components/ui";
import { IntelTabs, StepUpAction } from "@/components/console/intel";
import { RelTime } from "@/components/console/time";
import { cn } from "@/lib/format";

export const metadata: Metadata = { title: "Endpoints · Intelligence" };
export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, "low" | "medium" | "high" | "critical" | "neutral"> = { healthy: "low", degraded: "high", stale: "medium", incompatible: "critical", offline: "neutral", revoked: "critical" };
const KIND_ICON = { agent_host: Server, developer_mac: Laptop, ci_runner: Workflow };

export default async function EndpointsPage() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const roles = roleVersions(db);
  const eps = [...db.ml.endpoints].sort((a, b) => Number(b.real) - Number(a.real) || a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  const healthy = eps.filter((e) => e.state === "healthy").length;
  const p95s = eps.filter((e) => e.health.inference_p95_ms > 0).map((e) => e.health.inference_p95_ms).sort((a, b) => a - b);
  const median = p95s[Math.floor(p95s.length / 2)] ?? 0;
  const matrix = REGISTRY.benchmark_matrix as Array<{ version: string; precision: string; compute_units: string; warm_p50_us: number; warm_p95_us: number; pipeline_p95_us: number; cold_ms: number; peak_mb: number; artifact_bytes: number }>;
  const sus = REGISTRY.sustained as { seconds: number; events: number; cpu_percent: number; target_rate_eps: number; footprint_growth_mb: number; pipeline_us: { p95: number }; device: { cpu: string } } | null;
  const responder = user.roles.some((r) => ["owner", "admin", "policy_admin", "responder"].includes(r));
  return (
    <>
      <PageHeader eyebrow="Fleet" title="Endpoints" description="macOS endpoint runtimes: which model each runs, whether its manifest verified, and how it is performing. Portfolio mode simulates the demo fleet from measured benchmarks; real orbis-endpoint processes appear with a solid outline." />
      <IntelTabs reviewCount={reviewQueue(db, 0).total} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Endpoints" value={eps.length} hint={`${eps.filter((e) => e.real).length} real · ${eps.length - eps.filter((e) => e.real).length} simulated`} />
        <StatTile label="Healthy" value={healthy} suffix={`/${eps.length}`} hint={`${eps.filter((e) => e.state === "stale").length} stale · ${eps.filter((e) => e.state === "incompatible").length} incompatible`} />
        <StatTile label="Fleet median p95" value={Math.round(median * 1000)} suffix=" µs" hint="inference, budget 20 ms" />
        <StatTile label="Manifest sequence" value={db.ml.manifest_seq} hint="monotonic — blocks replay & downgrade" />
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Fleet"
          description={`Production ${roles.production ?? "—"}${roles.canary ? ` · canary ${roles.canary.version} at ${roles.canary.percent}% (by endpoint bucket)` : ""}`}
          action={roles.canary ? <StepUpAction label="Latency drill" title="Run the canary latency drill?" body="One canary endpoint reports p95 38 ms (budget 20 ms). The health monitor should roll the canary back automatically." path="/api/v1/ml/drills/latency" json={{}} disabled={!responder} disabledReason="Responder or admin" icon={<Activity className="size-3.5" />} /> : undefined}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-[13px]">
            <thead className="border-b border-line bg-surface-2 text-[12px] text-muted">
              <tr><th className="px-5 py-2 text-left font-medium">Endpoint</th><th className="px-3 py-2 text-left font-medium">State</th><th className="px-3 py-2 text-left font-medium">Model (active → assigned)</th><th className="px-3 py-2 text-left font-medium">Manifest</th><th className="px-3 py-2 text-right font-medium">p95 inference</th><th className="px-3 py-2 text-right font-medium">Memory</th><th className="px-3 py-2 text-right font-medium">Events 24h</th><th className="px-3 py-2 text-right font-medium">Bucket</th><th className="px-5 py-2 text-right font-medium">Last seen</th></tr>
            </thead>
            <tbody>
              {eps.map((e) => {
                const Icon = KIND_ICON[e.kind];
                const assigned = assignedVersion(db, e);
                return (
                  <tr key={e.id} className={cn("border-b border-line last:border-0", e.real && "bg-cobalt-50/40")}>
                    <td className="px-5 py-2"><div className="flex items-center gap-2"><Icon className="size-4 text-muted" /><div><div className="font-medium text-ink">{e.name}{e.real && <Badge tone="cobalt" className="ml-1.5">real</Badge>}</div><div className="font-mono text-[11.5px] text-faint">{e.id} · app {e.app_version}</div></div></div>{e.note && <div className="mt-0.5 max-w-md text-[11.5px] text-muted">{e.note}</div>}</td>
                    <td className="px-3 py-2"><Badge tone={STATE_TONE[e.state]}>{e.state}</Badge></td>
                    <td className="px-3 py-2 font-mono text-[12.5px]">{e.model_version ?? "none"}{assigned && assigned !== e.model_version && <span className="text-medium"> → {assigned}</span>}</td>
                    <td className="px-3 py-2 text-[12.5px]">{e.signature === "verified" ? <span className="text-low">✓ verified</span> : e.signature === "failed" ? <span className="text-critical">✗ refused</span> : <span className="text-faint">not yet</span>}</td>
                    <td className="tnum px-3 py-2 text-right">{e.health.inference_p95_ms ? `${(e.health.inference_p95_ms * 1000).toFixed(0)} µs` : "—"}</td>
                    <td className="tnum px-3 py-2 text-right">{e.health.memory_mb ? `${e.health.memory_mb.toFixed(1)} MB` : "—"}</td>
                    <td className="tnum px-3 py-2 text-right">{e.telemetry.events_24h.toLocaleString()}</td>
                    <td className="tnum px-3 py-2 text-right">{e.bucket}</td>
                    <td className="px-5 py-2 text-right"><RelTime iso={e.last_seen_at} className="text-[12px] text-muted" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader title="Measured benchmark matrix" description="Swift harness on Apple silicon · batch-1 Core ML. Precision and compute units barely matter for a 3.3k-parameter model — Core ML call overhead dominates." />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead className="border-b border-line bg-surface-2 text-[12px] text-muted"><tr><th className="px-5 py-2 text-left font-medium">Model</th><th className="px-3 py-2 text-left font-medium">Precision</th><th className="px-3 py-2 text-left font-medium">Compute</th><th className="px-3 py-2 text-right font-medium">p50</th><th className="px-3 py-2 text-right font-medium">p95</th><th className="px-3 py-2 text-right font-medium">Pipeline p95</th><th className="px-3 py-2 text-right font-medium">Cold</th><th className="px-5 py-2 text-right font-medium">Artifact</th></tr></thead>
              <tbody>
                {matrix.map((m, i) => (
                  <tr key={i} className="border-b border-line last:border-0"><td className="px-5 py-1.5 font-mono">{m.version}</td><td className="px-3 py-1.5">{m.precision}</td><td className="px-3 py-1.5">{m.compute_units}</td><td className="tnum px-3 py-1.5 text-right">{m.warm_p50_us.toFixed(1)} µs</td><td className="tnum px-3 py-1.5 text-right">{m.warm_p95_us.toFixed(1)} µs</td><td className="tnum px-3 py-1.5 text-right">{m.pipeline_p95_us.toFixed(1)} µs</td><td className="tnum px-3 py-1.5 text-right">{m.cold_ms.toFixed(1)} ms</td><td className="tnum px-5 py-1.5 text-right">{(m.artifact_bytes / 1024).toFixed(1)} KB</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {sus && <p className="border-t border-line px-5 py-3 text-[12.5px] text-muted">Sustained: {Math.round(sus.seconds / 60)} min at {sus.target_rate_eps} events/s on {sus.device.cpu} — {sus.events.toLocaleString()} events, pipeline p95 {sus.pipeline_us.p95.toFixed(0)} µs, {sus.cpu_percent.toFixed(2)}% of one core, footprint growth {sus.footprint_growth_mb.toFixed(2)} MB, 0 failures. Energy not measured (CPU time is the proxy).</p>}
        </Card>
        <Card>
          <CardHeader title="Connect a real endpoint" description="Run the Swift runtime on your Mac against this gateway." />
          <pre className="overflow-x-auto px-5 py-4 font-mono text-[11.5px] leading-relaxed text-ink-2">{`cd apps/macos-endpoint && swift build -c release
.build/release/orbis-endpoint sync \\
  --gateway http://localhost:4310 \\
  --key ${DEMO_KEYS.int_procurement} \\
  --endpoint-id ep_my_mac
.build/release/orbis-endpoint replay \\
  ../../fixtures/endpoint-events/hero.jsonl \\
  --gateway http://localhost:4310 \\
  --key ${DEMO_KEYS.int_procurement} --preflight`}</pre>
          <p className="border-t border-line px-5 py-3 text-[12.5px] text-muted">sync verifies the Ed25519 manifest, checks the artifact sha256, compiles the .mlpackage, smoke-tests it and swaps it in atomically. replay scores the hero stream locally with Core ML and sends the signal with the preflight.</p>
          <ul className="divide-y divide-line border-t border-line">
            {db.ml.activations.slice(-6).reverse().map((a, i) => (
              <li key={i} className="flex items-start justify-between gap-3 px-5 py-2 text-[12.5px]"><span className={a.activated ? "text-ink-2" : "text-critical"}>{a.activated ? "✓" : "✗"} <span className="font-mono">{a.endpoint_id}</span> {a.activated ? `activated ${a.version}${a.compile_ms ? ` · compile ${a.compile_ms} ms` : ""}` : a.error}</span><RelTime iso={a.at} className="shrink-0 text-faint" /></li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
