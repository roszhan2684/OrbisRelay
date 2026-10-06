import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { requireMlAdmin } from "@/lib/server/ml-api";
import { execute } from "@/lib/server/ops";

/** POST /v1/ml/settings — {mode?: off|advisory|escalate, kill_switch?: boolean, step_up}. The kill switch reverts every decision to deterministic policy. */
export const POST = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const body = await readJson<{ mode?: "off" | "advisory" | "escalate"; kill_switch?: boolean; step_up?: { verified?: boolean } }>(req);
  requireMlAdmin(user, body, body.kill_switch === true ? ["owner", "admin", "policy_admin", "responder"] : ["owner", "admin", "policy_admin"]);
  if (body.mode && !["off", "advisory", "escalate"].includes(body.mode)) throw new ApiError(422, "validation_error", "mode: off | advisory | escalate");
  return json(await execute(db, { kind: "ml_settings", user_id: user.id, mode: body.mode, kill_switch: typeof body.kill_switch === "boolean" ? body.kill_switch : undefined }));
});
