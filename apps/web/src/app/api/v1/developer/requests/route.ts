import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { actionSummary } from "@/lib/server/present";

/** GET /v1/developer/requests?integration= — request inspector feed. */
export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  const iid = new URL(req.url).searchParams.get("integration") ?? "int_sandbox";
  const list = db.actions.filter((a) => a.integration_id === iid).slice(-25).reverse();
  return json({ data: list.map((a) => ({ ...actionSummary(db, a), request_id: a.request_id, envelope_hash: a.envelope_hash })) });
});
