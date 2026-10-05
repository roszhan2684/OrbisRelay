import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

/** PATCH /v1/settings — tenant settings (admin). Every change is audited. */
export const PATCH = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => r === "admin" || r === "owner")) throw new ApiError(403, "forbidden", "Admin role required.");
  const body = await readJson(req);
  return json(await execute(db, { kind: "settings", user_id: user.id, patch: body }));
});
