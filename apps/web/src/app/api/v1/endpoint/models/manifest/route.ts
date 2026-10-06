import { ApiError } from "@/lib/server/gateway";
import { requireEndpoint } from "@/lib/server/endpoint-auth";
import { handle, json } from "@/lib/server/http";
import { signedManifest } from "@/lib/server/ml";
import { execute } from "@/lib/server/ops";

/** GET /v1/endpoint/models/manifest — Ed25519-signed manifest for the model this endpoint should run (production, or canary by bucket). */
export const GET = handle(async (req: Request) => {
  const { db, integration, endpointId } = await requireEndpoint(req);
  if (!db.ml.endpoints.some((e) => e.id === endpointId)) await execute(db, { kind: "endpoint_checkin", integration_id: integration.id, endpoint_id: endpointId, meta: { name: endpointId, os: "macOS", app_version: req.headers.get("user-agent")?.match(/orbis-endpoint\/([\d.]+)/)?.[1] } });
  const ep = db.ml.endpoints.find((e) => e.id === endpointId)!;
  const m = signedManifest(db, ep, new URL(req.url).origin);
  if (!m) throw new ApiError(404, "no_deployable_model", "No production model is deployable.");
  return json(m);
});
