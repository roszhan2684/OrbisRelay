import { handle, json } from "@/lib/server/http";
import { getDb } from "@/lib/server/store";

/** GET /v1/receipts/public-key — JWK for independent, offline receipt verification. */
export const GET = handle(async () => {
  const db = await getDb();
  return json({ keys: [{ kty: "OKP", crv: "Ed25519", x: db.signing_key.x, kid: db.signing_key.id, alg: "EdDSA", use: "sig" }] });
});
