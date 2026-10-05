import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";

export const GET = handle(async (req: Request) => {
  const { db, user, device_id } = await requireUser(req);
  const pending = db.approvals.filter((a) => a.status === "pending" && (a.assignees.includes(user.id) || user.groups.includes(a.route)) && !a.responses.some((r) => r.user_id === user.id));
  return json({
    user,
    tenant: { id: db.tenant.id, name: db.tenant.name, plan: db.tenant.plan, sso: db.tenant.settings.sso },
    device: db.devices.find((d) => d.id === device_id) ?? null,
    devices: db.devices.filter((d) => d.user_id === user.id),
    pending_count: pending.length,
    permissions: { can_freeze: user.roles.some((r) => ["responder", "admin", "owner"].includes(r)), can_unfreeze: user.roles.some((r) => ["admin", "owner"].includes(r)) },
  });
});
