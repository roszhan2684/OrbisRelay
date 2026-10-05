import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import { resetDb } from "@/lib/server/store";

/** POST /v1/demo/reset — rebuild the Northstar Cloud demo tenant from the seed. */
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  if (!user.roles.includes("owner") && !user.roles.includes("admin")) throw new ApiError(403, "forbidden", "Admin required.");
  const db = await resetDb();
  return json({ ok: true, actions: db.actions.length, pending: db.approvals.filter((a) => a.status === "pending").length });
});
