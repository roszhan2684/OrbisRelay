import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { computeQuality } from "@/lib/server/ml";

/** GET /v1/ml/quality — prediction distribution, abstention, disagreement with policy/humans, confirmed FP/FN. */
export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  return json(computeQuality(db));
});
