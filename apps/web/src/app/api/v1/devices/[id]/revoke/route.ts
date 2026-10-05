import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/devices/{id}/revoke — server-side revocation; sessions and step-up from this device are rejected afterwards. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const d = db.devices.find((x) => x.id === id);
  if (!d) throw new ApiError(404, "not_found", "Device not found.");
  if (d.user_id !== user.id && !user.roles.some((r) => r === "admin" || r === "owner")) throw new ApiError(403, "forbidden", "Only the owner or an admin can revoke a device.");
  return json(await execute(db, { kind: "device_revoke", device_id: id, user_id: user.id }));
});
