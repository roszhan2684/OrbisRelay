import { requireIntegration } from "@/lib/server/auth";
import { validateCallbackUrl, ApiError, type PreflightResult } from "@/lib/server/gateway";
import { execute } from "@/lib/server/ops";
import { handle, json, parseEnvelope, readJson } from "@/lib/server/http";
import { decisionResponse } from "@/lib/server/present";
import { parseEndpointSignal } from "@/lib/server/ml";

/** POST /v1/decisions/preflight — evaluate a proposed action before it executes. */
export const POST = handle(async (req: Request) => {
  const { db, integration } = await requireIntegration(req);
  const body = await readJson(req);
  const envelope = parseEnvelope(body);
  if (envelope.callback_url) {
    const v = validateCallbackUrl(envelope.callback_url);
    if (!v.ok) throw new ApiError(422, "invalid_callback_url", v.reason!, "Use a public https endpoint you control.");
  }
  const idem = req.headers.get("idempotency-key");
  if (idem && !body.request_id) envelope.request_id = idem.slice(0, 128);
  const endpoint = parseEndpointSignal(body.endpoint_signal);
  const { action, approval, idempotent_replay } = await execute<PreflightResult>(db, { kind: "preflight", integration_id: integration.id, envelope, endpoint });
  return json(decisionResponse(db, action, approval, idempotent_replay), { status: idempotent_replay ? 200 : 201 });
});
