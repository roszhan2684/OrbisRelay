import type { PolicyRule, PolicyVersion } from "@orbis/policy-core";
import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /v1/policies/{id}/draft — save (or replace) the working draft. Published versions are immutable. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => r === "policy_admin" || r === "owner")) throw new ApiError(403, "forbidden", "Policy admin role required.");
  if (!db.policies.some((p) => p.id === id)) throw new ApiError(404, "not_found", "Policy not found.");
  const body = await readJson<{ rules: PolicyRule[]; change_note?: string }>(req);
  if (!Array.isArray(body.rules) || body.rules.length === 0 || body.rules.length > 40) throw new ApiError(422, "validation_error", "rules must be a non-empty array (max 40).");
  for (const r of body.rules) {
    if (!r.id || !r.name || !r.effect || !r.when || !r.reason) throw new ApiError(422, "validation_error", `Rule ${r.id ?? "?"} is missing id/name/effect/when/reason.`);
  }
  return json(await execute<PolicyVersion>(db, { kind: "policy_draft", policy_id: id, user_id: user.id, rules: body.rules, note: body.change_note }));
});
