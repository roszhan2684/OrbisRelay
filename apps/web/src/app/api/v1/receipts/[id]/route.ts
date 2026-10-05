import { requireIntegration, requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import { receiptView } from "@/lib/server/present";

type Ctx = { params: Promise<{ id: string }> };

/** GET /v1/receipts/{id} — final signed decision receipt (latest revision + history). */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const machine = (req.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer orb_");
  const auth = machine ? await requireIntegration(req) : await requireUser(req);
  const tenantId = "integration" in auth ? auth.integration.tenant_id : auth.user.tenant_id;
  const r = receiptView(auth.db, id, tenantId);
  if (!r) throw new ApiError(404, "not_found", "Receipt not found.");
  return json(r);
});
