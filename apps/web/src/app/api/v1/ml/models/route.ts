import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { modelsView } from "@/lib/server/ml-api";

/** GET /v1/ml/models — registry: lifecycle state, release gates, parity, benchmarks, lineage. */
export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  return json(modelsView(db));
});
