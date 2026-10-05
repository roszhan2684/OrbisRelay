import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { audit, persist } from "@/lib/server/store";

const BOOL_KEYS = ["policy_publish_requires_second_approver", "metadata_only_mode", "scim"] as const;

/** PATCH /v1/settings — tenant settings (admin). Every change is audited. */
export const PATCH = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => r === "admin" || r === "owner")) throw new ApiError(403, "forbidden", "Admin role required.");
  const body = await readJson(req);
  const s = db.tenant.settings;
  const changes: string[] = [];
  for (const k of BOOL_KEYS) if (typeof body[k] === "boolean" && s[k] !== body[k]) { (s as Record<string, unknown>)[k] = body[k]; changes.push(`${k}=${body[k]}`); }
  if (body.notification_policy === "minimal_summary" || body.notification_policy === "title_only") { if (s.notification_policy !== body.notification_policy) changes.push(`notification_policy=${body.notification_policy}`); s.notification_policy = body.notification_policy; }
  if (typeof body.retention_days === "number" && [30, 90, 365, 2555].includes(body.retention_days)) { if (db.tenant.retention_days !== body.retention_days) changes.push(`retention_days=${body.retention_days}`); db.tenant.retention_days = body.retention_days; }
  if (changes.length) {
    audit(db, { at: new Date().toISOString(), type: "settings.changed", actor: { kind: "user", id: user.id, name: user.name }, summary: `Tenant settings changed: ${changes.join(", ")}` });
    persist();
  }
  return json({ tenant: db.tenant, changed: changes });
});
