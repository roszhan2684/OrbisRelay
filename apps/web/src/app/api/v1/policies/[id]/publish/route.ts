import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/policies/{id}/publish — publish a draft. Enterprise tenants require a second approver. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => r === "policy_admin" || r === "owner")) throw new ApiError(403, "forbidden", "Policy admin role required.");
  const body = await readJson<{ version?: number; second_approver_id?: string }>(req);
  return json(await execute(db, { kind: "policy_publish", policy_id: id, user_id: user.id, second_approver_id: body.second_approver_id, version: body.version }));
});
