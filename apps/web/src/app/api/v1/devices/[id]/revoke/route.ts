import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json } from "@/lib/server/http";
import { audit, persist } from "@/lib/server/store";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/devices/{id}/revoke — server-side revocation; step-up from this device is rejected afterwards. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const d = db.devices.find((x) => x.id === id);
  if (!d) throw new ApiError(404, "not_found", "Device not found.");
  if (d.user_id !== user.id && !user.roles.some((r) => r === "admin" || r === "owner")) throw new ApiError(403, "forbidden", "Only the owner or an admin can revoke a device.");
  d.trust = "revoked";
  d.push = false;
  db.sessions = db.sessions.filter((s) => s.device_id !== id);
  audit(db, { at: new Date().toISOString(), type: "device.revoked", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "device", id }, summary: `${d.name} revoked — sessions ended, step-up from this device rejected` });
  persist();
  return json(d);
});
