import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import e090 from "@/lib/ml/edge/eval/0.9.0.json";
import e100 from "@/lib/ml/edge/eval/1.0.0.json";
import e110 from "@/lib/ml/edge/eval/1.1.0.json";

const EVAL: Record<string, unknown> = { "0.9.0": e090, "1.0.0": e100, "1.1.0": e110 };
type Ctx = { params: Promise<{ id: string }> };

/** GET /v1/ml/models/{version}/evaluation — the machine-readable evaluation report. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireUser(req);
  if (!EVAL[id]) throw new ApiError(404, "not_found", "No evaluation for that version.");
  return json(EVAL[id]);
});
