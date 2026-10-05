import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { verifyAuditChain } from "@/lib/server/store";

/** GET /v1/audit/verify — recompute the full hash chain. */
export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  const t = performance.now();
  return json({ ...verifyAuditChain(db), ms: Math.round(performance.now() - t) });
});
