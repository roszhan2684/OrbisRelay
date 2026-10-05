import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { DB, Device, Integration, User } from "../domain";
import { id, sha256 } from "./crypto";
import { execute } from "./ops";
import { ApiError } from "./gateway";
import { getDb } from "./store";

export const SESSION_COOKIE = "orbis_session";

// Stateless, HMAC-signed sessions: any serverless instance can verify them without shared memory.
const SECRET = process.env.ORBIS_SESSION_SECRET ?? sha256("orbis-relay-demo-session-secret");
const TTL_MS = 12 * 3_600_000;

interface Claims {
  u: string;
  exp: number;
  d?: string;
  dn?: string;
  dm?: string;
  os?: string;
}

function signToken(prefix: "orbc" | "orbu", claims: Claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", SECRET).update(`${prefix}.${body}`).digest("base64url");
  return `${prefix}_${body}.${mac}`;
}

function verifyToken(prefix: "orbc" | "orbu", raw: string | undefined): Claims | null {
  if (!raw?.startsWith(`${prefix}_`)) return null;
  const [body, mac] = raw.slice(prefix.length + 1).split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", SECRET).update(`${prefix}.${body}`).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
    return c.exp > Date.now() ? c : null;
  } catch {
    return null;
  }
}

function bearer(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
}

async function consoleUser(db: DB): Promise<User | undefined> {
  const jar = await cookies();
  const c = verifyToken("orbc", jar.get(SESSION_COOKIE)?.value);
  return c ? db.users.find((u) => u.id === c.u && u.status === "active") : undefined;
}

/**
 * Integration (machine) authentication. Tenant is derived from the credential — never from
 * the payload. Console sessions may call the gateway only as the sandbox integration.
 */
export async function requireIntegration(req: Request): Promise<{ db: DB; integration: Integration }> {
  const db = await getDb();
  const key = bearer(req);
  if (key) {
    const h = sha256(key);
    for (const integration of db.integrations) {
      const k = integration.api_keys.find((x) => x.hash === h);
      if (k) {
        if (k.revoked_at) throw new ApiError(401, "key_revoked", "This API key was revoked.", "Create a new key in Developer → API keys.");
        k.last_used_at = new Date().toISOString();
        return { db, integration };
      }
    }
    if (key.startsWith("orb_")) throw new ApiError(401, "invalid_key", "Unknown API key.", "Check ORBIS_API_KEY; keys are shown once at creation.");
  }
  const user = await consoleUser(db);
  if (user) return { db, integration: db.integrations.find((i) => i.id === "int_sandbox")! };
  throw new ApiError(401, "unauthenticated", "Missing integration credential.", "Send Authorization: Bearer <ORBIS_API_KEY>.");
}

/** Human authentication: mobile bearer token or console session cookie. */
export async function requireUser(req: Request): Promise<{ db: DB; user: User; device_id?: string; channel: "ios" | "web" }> {
  const db = await getDb();
  const t = bearer(req);
  if (t && t.startsWith("orbu_")) {
    const c = verifyToken("orbu", t);
    const user = c && db.users.find((u) => u.id === c.u && u.status === "active");
    if (!c || !user) throw new ApiError(401, "invalid_session", "Session expired or revoked. Sign in again.");
    let device = db.devices.find((d) => d.id === c.d);
    if (device?.trust === "revoked") throw new ApiError(401, "device_revoked", "This device was revoked by an administrator.");
    if (!device && c.d) {
      // Registered on another instance (or before a demo reset): restore from the signed claims.
      const now = new Date().toISOString();
      device = { id: c.d, user_id: user.id, name: c.dn ?? "iPhone", model: c.dm ?? "iPhone", os: c.os ?? "iOS", registered_at: now, last_seen_at: now, trust: "registered", push: true, biometric: "face_id" } satisfies Device;
      db.devices.push(device);
    }
    if (device) device.last_seen_at = new Date().toISOString();
    return { db, user, device_id: c.d, channel: "ios" };
  }
  const user = await consoleUser(db);
  if (user) return { db, user, channel: "web" };
  throw new ApiError(401, "unauthenticated", "Sign in required.");
}

export async function currentConsoleUser() {
  const db = await getDb();
  return { db, user: await consoleUser(db) };
}

export async function createConsoleSession(db: DB, user: User) {
  await execute(db, { kind: "signin", user_id: user.id });
  return signToken("orbc", { u: user.id, exp: Date.now() + TTL_MS });
}

/** Demo SSO for the iOS app: registers (or reuses) the device and issues a mobile session token. */
export async function registerMobile(db: DB, email: string, device: { name: string; model: string; os: string }) {
  const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase() && u.status === "active");
  if (!user) throw new ApiError(404, "unknown_user", "No Northstar Cloud account for that email.");
  let dev = db.devices.find((d) => d.user_id === user.id && d.name === device.name && d.trust !== "revoked");
  const now = new Date().toISOString();
  if (!dev) {
    dev = { id: id("dev"), user_id: user.id, name: device.name.slice(0, 60), model: device.model.slice(0, 40), os: device.os.slice(0, 30), registered_at: now, last_seen_at: now, trust: "registered", push: true, biometric: "face_id" };
    await execute(db, { kind: "device_register", user_id: user.id, device: dev });
  }
  const t = signToken("orbu", { u: user.id, d: dev.id, dn: dev.name, dm: dev.model, os: dev.os, exp: Date.now() + 30 * 24 * 3_600_000 });
  return { token: t, user, device: dev };
}
