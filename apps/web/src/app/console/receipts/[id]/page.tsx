import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileCheck2 } from "lucide-react";
import { currentConsoleUser } from "@/lib/server/auth";
import { receiptView } from "@/lib/server/present";
import { PageHeader } from "@/components/console/shell";
import { ReceiptVerifier } from "@/components/receipt-verifier";
import { Badge, Card, CardHeader, Mono, RiskBadge, StatusBadge } from "@/components/ui";
import { dateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Receipt" };
export const dynamic = "force-dynamic";

export default async function ReceiptPage({ params }: PageProps<"/console/receipts/[id]">) {
  const { id } = await params;
  const { db, user } = await currentConsoleUser();
  if (!user) notFound();
  const r = receiptView(db, id, user.tenant_id);
  if (!r) notFound();
  const b = r.body;
  const row = (k: string, v: React.ReactNode) => (
    <div className="grid grid-cols-[150px_1fr] gap-3 border-b border-line px-5 py-2.5 text-[13.5px] last:border-0">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0">{v}</dd>
    </div>
  );
  return (
    <>
      <Link href={`/console/actions?id=${b.action_id}`} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ChevronLeft className="size-4" /> Action</Link>
      <PageHeader eyebrow="Decision receipt" title={b.action.title ?? b.action.type} description="Human-readable and machine-verifiable record of who decided what, under which policy version, with what evidence." actions={<Badge tone="low"><FileCheck2 className="size-3.5" /> Revision {r.revision} of {r.revisions.length}</Badge>} />
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="What was decided" />
            <dl>
              {row("Final status", <StatusBadge status={b.decision.final_status} />)}
              {row("Policy", b.policy ? <><Link className="hover:text-cobalt hover:underline" href={`/console/policies/${b.policy.id}`}>{b.policy.id}</Link> · v{b.policy.version} · <Mono>{b.policy.rule_id}</Mono></> : "No rule matched (default allow)")}
              {row("Risk", <span className="flex flex-wrap items-center gap-2"><RiskBadge level={b.risk.level} score={b.risk.score} /> <span className="text-[12px] text-muted">{b.risk.reasons.join(", ")}</span></span>)}
              {row("Actor", <>{b.actor.id} <span className="text-muted">({b.actor.type})</span></>)}
              {row("Caller", b.caller.integration_name)}
              {row("Original params", <Mono>{JSON.stringify(b.original_parameters)}</Mono>)}
              {b.approved_parameters && row("Approved params", <Mono className="text-low">{JSON.stringify(b.approved_parameters)}</Mono>)}
              {b.safe_alternative_applied && row("Safe alternative", <Badge tone="low">{b.safe_alternative_applied}</Badge>)}
              {row("Outcome", b.outcome ? <span className="capitalize">{b.outcome.status.replace("_", " ")} · {dateTime(b.outcome.reported_at)}</span> : <span className="text-muted">Not yet reported by caller</span>)}
              {row("AI enrichment", b.enrichment.used ? `Used (${b.enrichment.model})` : "Not used — deterministic policy only")}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Who approved" />
            {b.approvals.length === 0 ? (
              <p className="px-5 py-4 text-[13.5px] text-muted">No human was involved — decided automatically by policy in {new Date(b.timestamps.decided_at).getTime() - new Date(b.timestamps.received_at).getTime()}ms.</p>
            ) : (
              <ul className="divide-y divide-line">
                {b.approvals.map((x, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13.5px]">
                    <span><span className="font-medium">{x.name}</span> <span className="text-muted">· {x.decision.replace("_", " ")} via {x.channel}</span></span>
                    <span className="text-[12px] text-muted">{x.step_up !== "none" ? `${x.step_up} verified` : "no step-up"}{x.device_id ? ` · ${x.device_id}` : ""} · {dateTime(x.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Revision chain" description="Each revision commits to the previous body hash" />
            <ul className="divide-y divide-line font-mono text-[12px]">
              {r.revisions.map((v) => (
                <li key={v.revision} className="flex justify-between gap-3 px-5 py-2.5"><span>rev {v.revision}</span><span className="truncate text-muted">{v.body_hash}</span><span className="shrink-0 font-sans text-muted">{dateTime(v.issued_at)}</span></li>
              ))}
            </ul>
          </Card>
        </div>
        <ReceiptVerifier receipt={{ id: r.id, body: b as unknown as Record<string, unknown>, body_hash: r.body_hash, signature: r.signature, key_id: r.key_id, alg: r.alg }} />
      </div>
    </>
  );
}
