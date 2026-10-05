import { ApiError, latestReceipt, verifyReceipt } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { getDb } from "@/lib/server/store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /v1/receipts/{id}/verify — verify integrity. With a body ({body, signature, body_hash}) it verifies
 * the exported copy you hold; without one it verifies the stored latest revision. Public: proofs are not secrets.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const db = await getDb();
  const payload = await readJson<Record<string, unknown>>(req);
  if (payload.body && payload.signature) {
    const res = verifyReceipt(db, { body: payload.body as never, signature: String(payload.signature), body_hash: String(payload.body_hash ?? "") });
    return json({ receipt_id: id, ...res });
  }
  const r = latestReceipt(db, id, db.tenant.id);
  if (!r) throw new ApiError(404, "not_found", "Receipt not found.");
  return json({ receipt_id: id, revision: r.revision, ...verifyReceipt(db, r) });
});
