import { requireUser } from "@/lib/server/auth";
import { hashJson } from "@/lib/server/crypto";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { audit, emit, persist } from "@/lib/server/store";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/policies/{id}/publish — publish a draft. Enterprise tenants require a second approver. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => r === "policy_admin" || r === "owner")) throw new ApiError(403, "forbidden", "Policy admin role required.");
  const policy = db.policies.find((p) => p.id === id);
  if (!policy) throw new ApiError(404, "not_found", "Policy not found.");
  const body = await readJson<{ version?: number; second_approver_id?: string }>(req);
  const draft = policy.versions.find((v) => v.status === "draft" && (body.version === undefined || v.version === body.version));
  if (!draft) throw new ApiError(409, "no_draft", "There is no draft to publish.");
  let second;
  if (db.tenant.settings.policy_publish_requires_second_approver) {
    second = db.users.find((u) => u.id === body.second_approver_id);
    if (!second || second.id === user.id || !second.roles.includes("policy_admin")) throw new ApiError(422, "second_approver_required", "Select a different policy admin as second approver.");
  }
  const now = new Date().toISOString();
  for (const v of policy.versions) if (v.status === "published") v.status = "superseded";
  draft.status = "published";
  draft.published_at = now;
  draft.checksum = hashJson(draft.rules);
  policy.current_version = draft.version;
  audit(db, { at: now, type: "policy.published", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "policy", id }, summary: `${policy.name} v${draft.version} published — ${draft.change_note}`, data: { second_approver: second?.name, checksum: draft.checksum } });
  emit({ type: "policy.published", policy_id: id, version: draft.version });
  persist();
  return json({ policy_id: id, version: draft.version, checksum: draft.checksum });
});
