import { getDb } from "@/lib/server/store";
import { handle, json } from "@/lib/server/http";

/** GET /v1/endpoint/models/signing-key — public Ed25519 key for model manifests (pinned by endpoints at install). */
export const GET = handle(async () => {
  const db = await getDb();
  return json({ kty: "OKP", crv: "Ed25519", x: db.ml.signing_key.x, kid: db.ml.signing_key.id, use: "sig", purpose: "orbis model manifests" });
});
