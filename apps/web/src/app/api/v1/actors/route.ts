import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { computeAnalytics } from "@/lib/server/analytics";

/** GET /v1/actors — registry of agents, services, workflows and humans that propose actions. */
export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const stats = new Map(computeAnalytics(db, 7).actors.map((a) => [a.id, a]));
  const data = db.actors
    .filter((a) => a.tenant_id === user.tenant_id)
    .map((a) => {
      const freeze = db.freezes.find((f) => f.actor_id === a.id && !f.lifted_at) ?? null;
      const by = freeze ? db.users.find((u) => u.id === freeze.created_by) : undefined;
      return { ...a, integration_name: db.integrations.find((i) => i.id === a.integration_id)?.name, freeze: freeze ? { ...freeze, created_by_name: by?.name } : null, stats: stats.get(a.id) ?? null };
    });
  return json({ data, can_freeze: user.roles.some((r) => ["responder", "admin", "owner"].includes(r)), can_unfreeze: user.roles.some((r) => ["admin", "owner"].includes(r)) });
});
