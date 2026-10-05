import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { actionSummary } from "@/lib/server/present";

/** GET /v1/me/activity — chronological decisions and protected actions relevant to the user. */
export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const mine = db.approvals.filter((a) => a.responses.some((r) => r.user_id === user.id) || (a.status !== "pending" && user.groups.includes(a.route)));
  const decisions = mine.slice(-60).reverse().map((a) => ({ approval_id: a.id, title: a.title, status: a.status, risk: a.risk.level, actor: a.actor.name, integration: a.integration.name, resolved_at: a.resolved_at ?? a.created_at, my_response: a.responses.find((r) => r.user_id === user.id) ?? null, receipt_id: db.actions.find((x) => x.id === a.action_id)?.receipt_id ?? null }));
  const recent = db.actions.slice(-40).reverse().map((a) => actionSummary(db, a));
  return json({ decisions, recent_actions: recent });
});
