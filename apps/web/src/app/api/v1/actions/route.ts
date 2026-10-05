import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { actionSummary } from "@/lib/server/present";

/** GET /v1/actions — search every proposed action and its decision/outcome. */
export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").toLowerCase();
  const status = u.searchParams.get("status");
  const integration = u.searchParams.get("integration");
  const actor = u.searchParams.get("actor");
  const risk = u.searchParams.get("risk");
  const limit = Math.min(500, Number(u.searchParams.get("limit") ?? 100));
  let list = db.actions.filter((a) => a.tenant_id === user.tenant_id);
  if (status) list = list.filter((a) => a.final_status === status);
  if (integration) list = list.filter((a) => a.integration_id === integration);
  if (actor) list = list.filter((a) => a.envelope.actor.id === actor);
  if (risk) list = list.filter((a) => a.evaluation.risk.level === risk);
  const rows = list.map((a) => actionSummary(db, a)).filter((r) => !q || `${r.title} ${r.actor.name} ${r.integration.name} ${r.rule ?? ""} ${r.id}`.toLowerCase().includes(q));
  rows.sort((a, b) => b.received_at.localeCompare(a.received_at));
  return json({ data: rows.slice(0, limit), total: rows.length });
});
