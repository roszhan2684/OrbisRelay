import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { actionSummary } from "@/lib/server/present";
import { nowMs } from "@/lib/server/clock";
import { PageHeader } from "@/components/console/shell";
import { IntegrationsView, type IntegrationVM } from "./integrations-view";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const { db } = await currentConsoleUser();
  const now = nowMs();
  const vms: IntegrationVM[] = db.integrations.map((i) => {
    const acts = db.actions.filter((a) => a.integration_id === i.id);
    const daily = Array.from({ length: 14 }, (_, d) => {
      const end = now - (13 - d) * 86_400_000;
      return acts.filter((a) => {
        const t = new Date(a.received_at).getTime();
        return t <= end && t > end - 86_400_000;
      }).length;
    });
    const wh = db.webhooks.find((w) => w.id === i.webhook_id);
    const deliveries = wh ? db.deliveries.filter((d) => d.endpoint_id === wh.id) : [];
    const last = acts[acts.length - 1];
    const week = acts.filter((a) => now - new Date(a.received_at).getTime() < 7 * 86_400_000);
    return {
      id: i.id,
      name: i.name,
      vendor: i.vendor,
      kind: i.kind,
      description: i.description,
      mode: i.mode,
      status: i.status,
      sdk: i.sdk,
      created_at: i.created_at,
      first_protected_at: i.first_protected_at ?? null,
      last_seen_at: i.last_seen_at ?? null,
      actors: i.actor_ids.map((id) => db.actors.find((a) => a.id === id)?.name ?? id),
      keys: i.api_keys.map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, environment: k.environment, scopes: k.scopes, created_at: k.created_at, last_used_at: k.last_used_at ?? null, revoked_at: k.revoked_at ?? null })),
      daily,
      week_total: week.length,
      week_human: week.filter((a) => a.approval_id).length,
      week_denied: week.filter((a) => a.final_status === "deny").length,
      p95_latency: (() => {
        const l = acts.slice(-200).map((a) => a.latency_ms).sort((a, b) => a - b);
        return l[Math.floor(l.length * 0.95)] ?? 0;
      })(),
      last_decision: last ? actionSummary(db, last) : null,
      webhook: wh
        ? {
            url: wh.url,
            status: wh.status,
            secret_hint: wh.secret_hint,
            events: wh.events,
            success_rate: deliveries.length ? Math.round((deliveries.filter((d) => d.status_code < 300).length / deliveries.length) * 1000) / 10 : 100,
            recent: deliveries.slice(-8).reverse().map((d) => ({ id: d.id, event: d.event, status_code: d.status_code, attempt: d.attempt, at: d.delivered_at, ms: d.duration_ms })),
          }
        : null,
    };
  });
  return (
    <>
      <PageHeader eyebrow="Connected systems" title="Integrations" description="Customer applications, agent platforms and workflows that ask Orbis before they act. One generic API — not fifteen bespoke connectors." />
      <IntegrationsView items={vms} />
    </>
  );
}
