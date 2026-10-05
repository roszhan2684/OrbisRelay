import { requireIntegration } from "@/lib/server/auth";
import type { ApprovalRecord } from "@/lib/domain";
import { execute } from "@/lib/server/ops";
import { handle, json } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/approvals/{id}/cancel — caller withdraws a pending request. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, integration } = await requireIntegration(req);
  const ap = await execute<ApprovalRecord>(db, { kind: "cancel", approval_id: id, integration_id: integration.id });
  return json({ id: ap.id, status: ap.status });
});
