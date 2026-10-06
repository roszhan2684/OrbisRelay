import { requireUser } from "@/lib/server/auth";
import type { ModelStatus } from "@/lib/domain";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { requireMlAdmin } from "@/lib/server/ml-api";
import { execute } from "@/lib/server/ops";

type Ctx = { params: Promise<{ id: string }> };
const TARGETS: ModelStatus[] = ["shadow", "canary", "production"];

/** POST /v1/ml/models/{version}/promote — {to: shadow|canary|production, percent?, reason, step_up}. Blocked unless every release gate passed. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const body = await readJson<{ to?: ModelStatus; percent?: number; reason?: string; step_up?: { verified?: boolean } }>(req);
  requireMlAdmin(user, body);
  if (!body.to || !TARGETS.includes(body.to)) throw new ApiError(422, "validation_error", "to: one of shadow, canary, production");
  const percent = body.percent === undefined ? undefined : Number(body.percent);
  if (percent !== undefined && (!Number.isFinite(percent) || percent < 1 || percent > 99)) throw new ApiError(422, "validation_error", "percent: 1-99 for canary");
  const m = await execute(db, { kind: "ml_promote", version: id, to: body.to, percent, user_id: user.id, reason: String(body.reason ?? "").slice(0, 200) });
  return json(m);
});
