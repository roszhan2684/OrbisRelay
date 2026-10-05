import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";

export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const all = new URL(req.url).searchParams.get("scope") === "all" && user.roles.some((r) => ["admin", "owner", "auditor"].includes(r));
  const list = db.protect.filter((p) => p.tenant_id === user.tenant_id && (all || p.user_id === user.id)).slice().reverse();
  return json({ data: list.map((p) => ({ ...p, user_name: db.users.find((u) => u.id === p.user_id)?.name })) });
});
