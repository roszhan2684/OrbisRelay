import { requireIntegration, requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import { approvalView } from "@/lib/server/present";

type Ctx = { params: Promise<{ id: string }> };

/** GET /v1/approvals/{id} — status + safe display context. Callable by the owning integration or an approver. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const isMachine = (req.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer orb_");
  if (isMachine) {
    const { db, integration } = await requireIntegration(req);
    const ap = db.approvals.find((a) => a.id === id && a.tenant_id === integration.tenant_id && a.integration.id === integration.id);
    if (!ap) throw new ApiError(404, "not_found", "Approval not found.");
    const v = approvalView(db, ap);
    return json({ id: v.id, status: v.status, final_status: v.final_status, expires_at: v.expires_at, quorum_progress: v.quorum_progress, approved_parameters: v.approved_parameters, receipt_id: v.receipt_id, resolved_at: v.resolved_at ?? null });
  }
  const { db, user } = await requireUser(req);
  const ap = db.approvals.find((a) => a.id === id && a.tenant_id === user.tenant_id);
  if (!ap) throw new ApiError(404, "not_found", "Approval not found.");
  const assigned = ap.assignees.includes(user.id) || user.groups.includes(ap.route) || user.roles.includes("auditor") || user.roles.includes("admin");
  if (!assigned) throw new ApiError(403, "not_assigned", "You are not assigned to this approval.");
  return json(approvalView(db, ap, user));
});
