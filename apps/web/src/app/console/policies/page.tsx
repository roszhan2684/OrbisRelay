import type { Metadata } from "next";
import Link from "next/link";
import { FileClock, FlaskConical, ShieldCheck } from "lucide-react";
import { publishedVersion } from "@orbis/policy-core";
import { currentConsoleUser } from "@/lib/server/auth";
import { daysAgo } from "@/lib/server/clock";
import { computeAnalytics } from "@/lib/server/analytics";
import { PageHeader } from "@/components/console/shell";
import { Badge, Card } from "@/components/ui";
import { EFFECT_LABEL, EFFECT_TONE } from "@/lib/policy-text";
import { ago } from "@/lib/format";

export const metadata: Metadata = { title: "Policies" };
export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const { db } = await currentConsoleUser();
  const since = daysAgo(28);
  const recent = db.actions.filter((a) => new Date(a.received_at).getTime() > since);
  const a = computeAnalytics(db, 28);
  const packs = [...new Set(db.policies.map((p) => p.pack))];
  return (
    <>
      <PageHeader
        eyebrow="Policy studio"
        title="Policies"
        description="Deterministic, versioned rules own enforcement. Published versions are immutable; drafts are simulated against real traffic and published by two admins."
        actions={<Badge tone="cobalt"><ShieldCheck className="size-3.5" /> {a.policy_coverage.pct}% action-type coverage</Badge>}
      />
      <div className="mb-5 rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-ink-2 shadow-card">
        <span className="font-semibold text-ink">Evaluation order:</span> freeze check → every enabled policy's published version → the most severe matching effect wins
        (<span className="font-mono text-[12px]">allow &lt; allow_log &lt; warn &lt; require_confirmation &lt; require_approval &lt; require_quorum &lt; deny &lt; freeze</span>). AI enrichment can explain, never override.
      </div>
      {packs.map((pack) => (
        <section key={pack} className="mb-6">
          <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted">{pack}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {db.policies.filter((p) => p.pack === pack).map((p) => {
              const v = publishedVersion(p)!;
              const draft = p.versions.find((x) => x.status === "draft");
              const hits = recent.filter((x) => x.evaluation.matched.some((m) => m.policy_id === p.id)).length;
              const effects = [...new Set(v.rules.map((r) => r.effect))];
              return (
                <Link key={p.id} href={`/console/policies/${p.id}`} className="group">
                  <Card className="h-full p-4 transition group-hover:border-cobalt/40 group-hover:shadow-pop">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-[15px] font-semibold tracking-[-0.01em] group-hover:text-cobalt">{p.name}</h3>
                      <Badge tone="neutral" className="font-mono">v{p.current_version}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[13px] text-muted">{p.description}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {effects.map((e) => <Badge key={e} tone={EFFECT_TONE[e]}>{EFFECT_LABEL[e]}</Badge>)}
                    </div>
                    <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-[12px] text-muted">
                      <span className="tnum">{v.rules.length} rules</span>
                      <span className="tnum">{hits.toLocaleString()} matches / 28d</span>
                      <span className="flex items-center gap-1"><FileClock className="size-3.5" /> {v.published_at ? ago(v.published_at) : "—"}</span>
                      {draft && <span className="ml-auto flex items-center gap-1 font-medium text-cobalt"><FlaskConical className="size-3.5" /> Draft v{draft.version}</span>}
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}
