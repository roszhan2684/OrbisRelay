import { registerMobile } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { getDb } from "@/lib/server/store";

/** POST /v1/auth/device — demo SSO for Orbis iOS; registers the device and returns a mobile session. */
export const POST = handle(async (req: Request) => {
  const db = await getDb();
  const b = await readJson(req);
  const email = String(b.email ?? "");
  if (!email.includes("@")) throw new ApiError(422, "validation_error", "email required");
  const res = await registerMobile(db, email, { name: String(b.device_name ?? "iPhone"), model: String(b.model ?? "iPhone"), os: String(b.os ?? "iOS") });
  return json({ token: res.token, user: res.user, device: res.device, tenant: { id: db.tenant.id, name: db.tenant.name } }, { status: 201 });
});
