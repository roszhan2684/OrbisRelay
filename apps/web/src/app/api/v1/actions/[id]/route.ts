import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import { actionSummary, approvalView, receiptView } from "@/lib/server/present";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const a = db.actions.find((x) => x.id === id && x.tenant_id === user.tenant_id);
  if (!a) throw new ApiError(404, "not_found", "Action not found.");
  const ap = db.approvals.find((p) => p.id === a.approval_id);
  return json({ summary: actionSummary(db, a), action: a, approval: ap ? approvalView(db, ap, user) : null, receipt: a.receipt_id ? receiptView(db, a.receipt_id, user.tenant_id) : null });
});
