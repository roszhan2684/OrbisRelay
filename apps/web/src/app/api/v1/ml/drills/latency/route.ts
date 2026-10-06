import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { requireMlAdmin } from "@/lib/server/ml-api";
import { roleVersions } from "@/lib/server/ml";
import { execute } from "@/lib/server/ops";

/**
 * POST /v1/ml/drills/latency — Demo D. Makes one canary endpoint report a latency spike so the health
 * monitor's automatic-rollback rule fires exactly as it would for real telemetry.
 */
export const POST = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const body = await readJson<{ step_up?: { verified?: boolean } }>(req);
  requireMlAdmin(user, body, ["owner", "admin", "policy_admin", "responder"]);
  const roles = roleVersions(db);
  if (!roles.canary) throw new ApiError(409, "no_canary", "No model is in canary. Promote a gated model to canary first.");
  const ep = db.ml.endpoints.filter((e) => e.state !== "incompatible" && e.bucket < roles.canary!.percent).sort((a, b) => a.bucket - b.bucket)[0];
  if (!ep) throw new ApiError(409, "no_canary_endpoint", "No endpoint falls inside the canary percentage.");
  const res = await execute(db, { kind: "endpoint_checkin", integration_id: ep.integration_id ?? "int_ops", endpoint_id: ep.id, drill: true, health: { active_model: roles.canary.version, inference_p95_ms: 38.4, pipeline_p95_ms: 41.2, failures_24h: 0 } });
  return json({ endpoint: ep.id, ...(res as object) });
});
