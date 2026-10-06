import { requireEndpoint } from "@/lib/server/endpoint-auth";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

/** POST /v1/endpoint/health — endpoint health snapshot; may trigger automatic canary rollback. */
export const POST = handle(async (req: Request) => {
  const body = await readJson<{ endpoint_id?: string; health?: Record<string, unknown>; meta?: { name?: string; os?: string; app_version?: string } }>(req);
  const { db, integration, endpointId } = await requireEndpoint(req, body.endpoint_id);
  const h = body.health ?? {};
  const num = (k: string) => (typeof h[k] === "number" ? (h[k] as number) : undefined);
  const res = await execute(db, {
    kind: "endpoint_checkin", integration_id: integration.id, endpoint_id: endpointId, meta: body.meta ?? { app_version: req.headers.get("user-agent")?.match(/orbis-endpoint\/([\d.]+)/)?.[1], os: "macOS", name: endpointId },
    health: { inference_p95_ms: num("inference_p95_ms"), pipeline_p95_ms: num("pipeline_p95_ms"), memory_mb: num("memory_mb"), cpu_percent: num("cpu_percent"), queue_depth: num("queue_depth"), failures_24h: num("inference_failures"), fallbacks_24h: num("fallbacks"), active_model: typeof h.active_model === "string" ? h.active_model : null, stale_model: h.stale_model === true, kill_switch: h.kill_switch === true },
  });
  return json(res);
});
