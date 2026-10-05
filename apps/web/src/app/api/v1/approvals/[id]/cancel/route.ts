import { requireIntegration } from "@/lib/server/auth";
import { cancelApproval } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/approvals/{id}/cancel — caller withdraws a pending request. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, integration } = await requireIntegration(req);
  const ap = cancelApproval(db, id, integration);
  return json({ id: ap.id, status: ap.status });
});
