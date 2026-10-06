import { ApiError } from "@/lib/server/gateway";
import { requireEndpoint } from "@/lib/server/endpoint-auth";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

/**
 * POST /v1/endpoint/events/batch — privacy-filtered telemetry from the endpoint's bounded queue.
 * Only aggregate counts are retained server-side (bounded retention); bodies are validated and dropped.
 */
export const POST = handle(async (req: Request) => {
  const body = await readJson<{ endpoint_id?: string; events?: Array<{ priority?: number; body?: Record<string, unknown> }> }>(req);
  const { db, integration, endpointId } = await requireEndpoint(req, body.endpoint_id);
  if (!Array.isArray(body.events)) throw new ApiError(422, "validation_error", "events: array required");
  if (body.events.length > 1000) throw new ApiError(413, "batch_too_large", "Max 1000 events per batch.");
  for (const e of body.events) {
    const b = e.body ?? {};
    if (Object.keys(b).some((k) => !["event_id", "actor_id", "action_type", "class", "risk", "anomaly", "source", "model_version", "reasons"].includes(k))) throw new ApiError(422, "unexpected_field", "Telemetry may only carry the privacy-filtered summary fields.");
  }
  const high = body.events.filter((e) => e.priority === 1).length;
  await execute(db, { kind: "endpoint_checkin", integration_id: integration.id, endpoint_id: endpointId, events: { count: body.events.length, high_priority: high } });
  return json({ accepted: body.events.length, high_priority: high }, { status: 202 });
});
