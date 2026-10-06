import { requireUser } from "@/lib/server/auth";
import { handle, json, readJson } from "@/lib/server/http";
import { requireMlAdmin } from "@/lib/server/ml-api";
import { execute } from "@/lib/server/ops";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/ml/models/{version}/rollback — {reason, step_up}. Restores the previous production model and bumps the manifest sequence. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const body = await readJson<{ reason?: string; step_up?: { verified?: boolean } }>(req);
  requireMlAdmin(user, body, ["owner", "admin", "policy_admin", "responder"]);
  return json(await execute(db, { kind: "ml_rollback", version: id, user_id: user.id, reason: String(body.reason ?? "manual rollback").slice(0, 200) }));
});
