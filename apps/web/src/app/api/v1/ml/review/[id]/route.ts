import { requireUser } from "@/lib/server/auth";
import type { MlLabel } from "@/lib/domain";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

type Ctx = { params: Promise<{ id: string }> };
const LABELS: MlLabel[] = ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"];

/** POST /v1/ml/review/{prediction_id} — analyst label. Goes into the next dataset version, never the live model. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const body = await readJson<{ label?: MlLabel; note?: string }>(req);
  if (!body.label || !LABELS.includes(body.label)) throw new ApiError(422, "validation_error", `label: one of ${LABELS.join(", ")}`);
  return json(await execute(db, { kind: "ml_review", prediction_id: id, label: body.label, user_id: user.id, note: body.note }), { status: 201 });
});
