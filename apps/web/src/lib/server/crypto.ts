import "server-only";
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { canonicalize } from "../canonical";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashJson(value: unknown) {
  return sha256(canonicalize(value));
}

/**
 * Ed25519 signing key. Derived deterministically from ORBIS_SIGNING_SEED so every serverless
 * instance (and every re-seed) shares one key and any receipt verifies anywhere. Production would
 * hold this in a KMS/HSM; `key_id` on each receipt already supports rotation.
 */
export function newSigningKey(id: string, seedMaterial = process.env.ORBIS_SIGNING_SEED ?? "orbis-relay-demo-signing-key") {
  const seed = createHash("sha256").update(`orbis-ed25519:${seedMaterial}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    id,
    private_pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    public_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    x: jwk.x,
  };
}

const keyCache = new Map<string, ReturnType<typeof createPrivateKey>>();

export function signCanonical(privatePem: string, body: unknown) {
  let key = keyCache.get(privatePem);
  if (!key) keyCache.set(privatePem, (key = createPrivateKey(privatePem)));
  return sign(null, Buffer.from(canonicalize(body)), key).toString("base64url");
}

export function verifyCanonical(publicPem: string, body: unknown, signature: string) {
  try {
    return verify(null, Buffer.from(canonicalize(body)), createPublicKey(publicPem), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Webhook signature: `t=<unix>,v1=<hex hmac(secret, t + "." + body)>` (Stripe-style, replay-resistant). */
export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function token(prefix: string, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

let seededIds: { seed: string; n: number } | null = null;

export function id(prefix: string) {
  const bytes = seededIds ? createHash("sha256").update(`${seededIds.seed}:${seededIds.n++}`).digest().subarray(0, 9) : randomBytes(9);
  return `${prefix}_${Buffer.from(bytes).toString("base64url").replace(/[-_]/g, "x")}`;
}

/** Run `fn` with deterministic ids, so independent instances build byte-identical seed data. */
export function withSeededIds<T>(seed: string, fn: () => T): T {
  const outer = seededIds; // nestable: restore the enclosing deterministic scope afterwards
  seededIds = { seed, n: 0 };
  try {
    return fn();
  } finally {
    seededIds = outer;
  }
}
