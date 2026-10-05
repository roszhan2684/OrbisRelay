import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { computeAnalytics } from "@/lib/server/analytics";
import { PageHeader } from "@/components/console/shell";
import { ActorsView, type ActorVM } from "./actors-view";

export const metadata: Metadata = { title: "Agents & Actors" };
export const dynamic = "force-dynamic";

export default async function ActorsPage() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const stats = new Map(computeAnalytics(db, 7).actors.map((a) => [a.id, a]));
  const name = (uid: string | undefined) => db.users.find((u) => u.id === uid)?.name ?? uid ?? "";
  const actors: ActorVM[] = db.actors.map((a) => {
    const f = db.freezes.find((x) => x.actor_id === a.id && !x.lifted_at);
    const s = stats.get(a.id);
    return {
      id: a.id, name: a.name, type: a.type, description: a.description, owner_team: a.owner_team,
      integration: db.integrations.find((i) => i.id === a.integration_id)?.name ?? a.integration_id,
      trust: a.trust, baseline_per_hour: a.baseline_per_hour, tools: a.tools,
      stats: s ? { total: s.total, human: s.human, blocked: s.blocked, anomalies: s.anomalies, hourly: s.hourly } : null,
      freeze: f ? { id: f.id, reason: f.reason, by: name(f.created_by), at: f.created_at, channel: f.channel, blocked: f.blocked_count } : null,
    };
  });
  actors.sort((a, b) => Number(!!b.freeze) - Number(!!a.freeze) || (b.stats?.total ?? 0) - (a.stats?.total ?? 0));
  const history = [...db.freezes].reverse().map((f) => ({ id: f.id, actor: db.actors.find((a) => a.id === f.actor_id)?.name ?? f.actor_id, reason: f.reason, by: name(f.created_by), at: f.created_at, lifted_at: f.lifted_at ?? null, lifted_by: f.lifted_by ? name(f.lifted_by) : null, lift_reason: f.lift_reason ?? null, blocked: f.blocked_count, channel: f.channel }));
  return (
    <>
      <PageHeader eyebrow="Registry" title="Agents & Actors" description="Every agent, workflow, service and human that can propose actions — with behaviour baselines and the emergency freeze." />
      <ActorsView actors={actors} history={history} canFreeze={user.roles.some((r) => ["responder", "admin", "owner"].includes(r))} canUnfreeze={user.roles.some((r) => ["admin", "owner"].includes(r))} />
    </>
  );
}
