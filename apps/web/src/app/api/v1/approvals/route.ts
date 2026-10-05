import { requireIntegration, requireUser } from "@/lib/server/auth";
import { ApiError, type PreflightResult } from "@/lib/server/gateway";
import { execute } from "@/lib/server/ops";
import { handle, json, parseEnvelope, readJson } from "@/lib/server/http";
import { approvalView, decisionResponse } from "@/lib/server/present";

/** POST /v1/approvals — the caller already knows a human must decide. */
export const POST = handle(async (req: Request) => {
  const { db, integration } = await requireIntegration(req);
  const body = await readJson(req);
  const route = typeof body.route === "string" ? body.route : "security";
  if (!db.users.some((u) => u.groups.includes(route))) throw new ApiError(422, "unknown_route", `No approvers are configured for route "${route}".`);
  const envelope = parseEnvelope(body);
  const { action, approval, idempotent_replay } = await execute<PreflightResult>(db, { kind: "preflight", integration_id: integration.id, envelope, force: { route, reason: String(body.reason ?? "The calling workflow requested human approval.").slice(0, 300) } });
  return json(decisionResponse(db, action, approval, idempotent_replay), { status: 201 });
});

/** GET /v1/approvals?status=pending&scope=mine|all — approver inbox / console queue. */
export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const scope = url.searchParams.get("scope") ?? "mine";
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 100));
  let list = db.approvals.filter((a) => a.tenant_id === user.tenant_id);
  if (scope === "mine") list = list.filter((a) => a.assignees.includes(user.id) || user.groups.includes(a.route));
  if (status) list = list.filter((a) => (status === "resolved" ? a.status !== "pending" : a.status === status));
  list = [...list].sort((a, b) => (a.status === "pending" && b.status === "pending" ? b.risk.score - a.risk.score || a.expires_at.localeCompare(b.expires_at) : b.created_at.localeCompare(a.created_at)));
  return json({ data: list.slice(0, limit).map((a) => approvalView(db, a, user)), total: list.length });
});
