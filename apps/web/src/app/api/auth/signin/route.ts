import { cookies } from "next/headers";
import { createConsoleSession, SESSION_COOKIE } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { getDb } from "@/lib/server/store";

/** Demo SSO: in production this is the OIDC/SAML callback. */
export const POST = handle(async (req: Request) => {
  const db = await getDb();
  const body = await readJson(req);
  const email = String(body.email ?? "alex.chen@northstar.cloud").toLowerCase();
  const user = db.users.find((u) => u.email === email && u.status === "active");
  if (!user) throw new ApiError(404, "unknown_user", "No account for that email.");
  const t = await createConsoleSession(db, user);
  (await cookies()).set(SESSION_COOKIE, t, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" && !process.env.ORBIS_INSECURE_COOKIES, maxAge: 60 * 60 * 12 });
  return json({ ok: true, user: { id: user.id, name: user.name } });
});
