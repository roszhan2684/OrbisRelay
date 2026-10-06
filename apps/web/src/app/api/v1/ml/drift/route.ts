import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { computeDrift } from "@/lib/server/ml";

/** GET /v1/ml/drift — feature/prediction PSI per 7-day window vs the reference window, OOD rate, behavioural drift, retrain trigger. */
export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  return json(computeDrift(db));
});
