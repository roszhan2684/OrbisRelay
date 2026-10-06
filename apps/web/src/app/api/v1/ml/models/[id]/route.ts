import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import { modelView } from "@/lib/server/ml-api";

type Ctx = { params: Promise<{ id: string }> };

/** GET /v1/ml/models/{version} */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db } = await requireUser(req);
  const m = db.ml.models.find((x) => x.version === id);
  if (!m) throw new ApiError(404, "not_found", "Unknown model version.");
  return json(modelView(db, m));
});
