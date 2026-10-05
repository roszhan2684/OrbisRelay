import type { PolicyRule } from "@orbis/policy-core";
import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { audit, persist } from "@/lib/server/store";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /v1/policies/{id}/draft — save (or replace) the working draft. Published versions are immutable. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => r === "policy_admin" || r === "owner")) throw new ApiError(403, "forbidden", "Policy admin role required.");
  const policy = db.policies.find((p) => p.id === id);
  if (!policy) throw new ApiError(404, "not_found", "Policy not found.");
  const body = await readJson<{ rules: PolicyRule[]; change_note?: string }>(req);
  if (!Array.isArray(body.rules) || body.rules.length === 0 || body.rules.length > 40) throw new ApiError(422, "validation_error", "rules must be a non-empty array (max 40).");
  for (const r of body.rules) {
    if (!r.id || !r.name || !r.effect || !r.when || !r.reason) throw new ApiError(422, "validation_error", `Rule ${r.id ?? "?"} is missing id/name/effect/when/reason.`);
  }
  let draft = policy.versions.find((v) => v.status === "draft");
  const now = new Date().toISOString();
  if (!draft) {
    draft = { policy_id: id, version: Math.max(...policy.versions.map((v) => v.version)) + 1, status: "draft", rules: body.rules, change_note: body.change_note ?? "Draft", created_at: now, created_by: user.email.split("@")[0] };
    policy.versions.push(draft);
  } else {
    draft.rules = body.rules;
    draft.change_note = body.change_note ?? draft.change_note;
    draft.created_at = now;
  }
  audit(db, { at: now, type: "policy.draft_saved", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "policy", id }, summary: `${policy.name} v${draft.version} draft saved — ${draft.change_note}` });
  persist();
  return json(draft);
});
