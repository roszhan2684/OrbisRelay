import { verifyReceipt } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { getDb } from "@/lib/server/store";

/** POST /v1/receipts/verify — verify a pasted receipt export without knowing its id. */
export const POST = handle(async (req: Request) => {
  const db = await getDb();
  const p = await readJson<Record<string, unknown>>(req);
  return json(verifyReceipt(db, { body: p.body as never, signature: String(p.signature ?? ""), body_hash: String(p.body_hash ?? "") }));
});
