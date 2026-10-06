import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { assignedVersion } from "@/lib/server/ml";

/** GET /v1/ml/endpoints — fleet: active vs assigned model, health, stale/incompatible status. */
export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  return json({ endpoints: db.ml.endpoints.map((e) => ({ ...e, assigned_version: assignedVersion(db, e) })), activations: db.ml.activations.slice(-50).reverse() });
});
