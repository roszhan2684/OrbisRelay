import { requireIntegration } from "@/lib/server/auth";
import { ApiError, reportOutcome } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };
const STATUSES = ["succeeded", "failed", "not_executed", "unknown"] as const;

/** POST /v1/actions/{id}/outcome — caller reports what actually happened (idempotent). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, integration } = await requireIntegration(req);
  const body = await readJson(req);
  const status = body.status as (typeof STATUSES)[number];
  if (!STATUSES.includes(status)) throw new ApiError(422, "validation_error", `status must be one of ${STATUSES.join(", ")}`);
  const { action, idempotent_replay } = reportOutcome(db, id, integration, status, typeof body.detail === "string" ? body.detail : undefined);
  return json({ action_id: action.id, outcome: action.outcome, receipt_id: action.receipt_id, idempotent_replay });
});
