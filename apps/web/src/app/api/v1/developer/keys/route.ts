import { requireUser } from "@/lib/server/auth";
import { id, sha256, token } from "@/lib/server/crypto";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { audit, persist } from "@/lib/server/store";

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
  integration.api_keys.push(key);
  audit(db, { at: key.created_at, type: "api_key.created", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "integration", id: integration.id }, summary: `API key ${key.prefix}… created for ${integration.name}` });
  persist();
  return json({ ...key, hash: undefined, plaintext }, { status: 201 });
});

/** DELETE /v1/developer/keys?id= — revoke immediately. */
export const DELETE = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => ["developer", "admin", "owner"].includes(r))) throw new ApiError(403, "forbidden", "Developer role required.");
  const kid = new URL(req.url).searchParams.get("id");
  for (const i of db.integrations) {
    const k = i.api_keys.find((x) => x.id === kid);
    if (k && i.tenant_id === user.tenant_id) {
      k.revoked_at = new Date().toISOString();
      audit(db, { at: k.revoked_at, type: "api_key.revoked", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "integration", id: i.id }, summary: `API key ${k.prefix}… revoked` });
      persist();
      return json({ id: k.id, revoked_at: k.revoked_at });
    }
  }
  throw new ApiError(404, "not_found", "Key not found.");
});
