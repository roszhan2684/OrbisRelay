import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";

/** GET /v1/audit/events — search the tenant's append-only, hash-chained audit trail. */
export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => ["auditor", "admin", "owner"].includes(r))) throw new ApiError(403, "forbidden", "Auditor role required.");
  const u = new URL(req.url);
  const type = u.searchParams.get("type");
  const q = (u.searchParams.get("q") ?? "").toLowerCase();
  const limit = Math.min(500, Number(u.searchParams.get("limit") ?? 100));
  let list = db.audit.filter((e) => e.tenant_id === user.tenant_id);
  if (type) list = list.filter((e) => e.type.startsWith(type));
  if (q) list = list.filter((e) => `${e.summary} ${e.actor.name} ${e.target?.id ?? ""}`.toLowerCase().includes(q));
  return json({ data: list.slice(-limit).reverse(), total: list.length });
});
