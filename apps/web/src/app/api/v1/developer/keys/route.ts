import { requireUser } from "@/lib/server/auth";
import { id, sha256, token } from "@/lib/server/crypto";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

/** POST /v1/developer/keys — create a scoped API key. Plaintext is returned exactly once. */
export const POST = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => ["developer", "admin", "owner"].includes(r))) throw new ApiError(403, "forbidden", "Developer role required.");
  const body = await readJson(req);
  const integration = db.integrations.find((i) => i.id === body.integration_id && i.tenant_id === user.tenant_id);
  if (!integration) throw new ApiError(404, "not_found", "Integration not found.");
  const env = integration.kind === "sandbox" ? "test" : "live";
  const plaintext = token(`orb_${env}_np`, 18);
  const key = { id: id("key"), label: String(body.label ?? "New key").slice(0, 60), prefix: plaintext.slice(0, 16), hash: sha256(plaintext), environment: (env === "test" ? "sandbox" : "production") as "sandbox" | "production", scopes: ["decisions:write", "approvals:write", "outcomes:write", "receipts:read"], created_at: new Date().toISOString() };
  await execute(db, { kind: "key_create", integration_id: integration.id, user_id: user.id, key });
  return json({ ...key, hash: undefined, plaintext }, { status: 201 });
});

/** DELETE /v1/developer/keys?id= — revoke immediately. */
export const DELETE = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => ["developer", "admin", "owner"].includes(r))) throw new ApiError(403, "forbidden", "Developer role required.");
  const kid = new URL(req.url).searchParams.get("id");
  if (!kid || !db.integrations.some((i) => i.tenant_id === user.tenant_id && i.api_keys.some((k) => k.id === kid))) throw new ApiError(404, "not_found", "Key not found.");
  const k = await execute<{ id: string; revoked_at?: string }>(db, { kind: "key_revoke", key_id: kid, user_id: user.id });
  return json({ id: k.id, revoked_at: k.revoked_at });
});
