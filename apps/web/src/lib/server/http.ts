import "server-only";
import type { ActionEnvelope } from "@orbis/policy-core";
import { ApiError } from "./gateway";

const MAX_BODY = 64 * 1024;

export function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init.headers ?? {}) } });
}

export function errorResponse(e: unknown) {
  if (e instanceof ApiError) {
    return json({ error: { code: e.code, message: e.message, remediation: e.remediation } }, { status: e.status });
  }
  console.error("[orbis] unhandled", e instanceof Error ? e.message : "unknown error");
  return json({ error: { code: "internal", message: "Unexpected server error." } }, { status: 500 });
}

export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new ApiError(413, "payload_too_large", "Request body exceeds 64 KB.", "Send a redacted summary instead of raw content.");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "payload_too_large", "Request body exceeds 64 KB.", "Send a redacted summary instead of raw content.");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON.");
  }
}

const ACTOR_TYPES = ["human", "service", "workflow", "agent", "automation"];
const ACTION_TYPES = ["external_send", "email_send", "payment", "refund", "deploy", "grant_access", "data_export", "record_release", "operational_stop", "config_change", "delete", "invoke_tool"];
const CLASSES = ["public", "internal", "confidential", "restricted", "regulated"];
const DEST_TYPES = ["internal", "external_domain", "external_model", "internal_model", "beneficiary", "environment", "partner", "customer"];

function fail(field: string, msg: string): never {
  throw new ApiError(422, "validation_error", `${field}: ${msg}`, "See /docs#envelope for the canonical action envelope.");
}
const str = (v: unknown, field: string, max = 200) => {
  if (typeof v !== "string" || !v.trim()) fail(field, "required string");
  if ((v as string).length > max) fail(field, `max ${max} characters`);
  return v as string;
};

/** Schema validation for the canonical action envelope. Unknown fields are dropped. */
export function parseEnvelope(body: Record<string, unknown>): ActionEnvelope {
  const actor = body.actor as Record<string, unknown> | undefined;
  const action = body.action as Record<string, unknown> | undefined;
  if (!actor || typeof actor !== "object") fail("actor", "required object");
  if (!action || typeof action !== "object") fail("action", "required object");
  if (!ACTOR_TYPES.includes(actor.type as string)) fail("actor.type", `one of ${ACTOR_TYPES.join(", ")}`);
  if (!ACTION_TYPES.includes(action.type as string)) fail("action.type", `one of ${ACTION_TYPES.join(", ")}`);
  const resources = Array.isArray(body.resources) ? body.resources : [];
  if (resources.length > 50) fail("resources", "max 50 items");
  const dest = body.destination as Record<string, unknown> | undefined;
  if (dest && !DEST_TYPES.includes(dest.type as string)) fail("destination.type", `one of ${DEST_TYPES.join(", ")}`);
  const ttl = body.ttl_seconds === undefined ? undefined : Number(body.ttl_seconds);
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 30 || ttl > 86_400)) fail("ttl_seconds", "between 30 and 86400");

  const params = action.parameters && typeof action.parameters === "object" ? (action.parameters as Record<string, unknown>) : undefined;
  const cleanParams = params
    ? Object.fromEntries(Object.entries(params).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 20)) as Record<string, string | number | boolean>
    : undefined;

  return {
    request_id: str(body.request_id ?? `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, "request_id", 128),
    actor: { type: actor.type as ActionEnvelope["actor"]["type"], id: str(actor.id, "actor.id", 120), owner: typeof actor.owner === "string" ? actor.owner.slice(0, 80) : undefined, display_name: typeof actor.display_name === "string" ? actor.display_name.slice(0, 80) : undefined },
    action: {
      type: action.type as ActionEnvelope["action"]["type"],
      tool: typeof action.tool === "string" ? action.tool.slice(0, 120) : undefined,
      title: typeof action.title === "string" ? action.title.slice(0, 120) : undefined,
      arguments_summary: typeof action.arguments_summary === "string" ? action.arguments_summary.slice(0, 500) : undefined,
      parameters: cleanParams,
    },
    resources: resources.map((r: Record<string, unknown>, i: number) => {
      if (r.classification !== undefined && !CLASSES.includes(r.classification as string)) fail(`resources[${i}].classification`, `one of ${CLASSES.join(", ")}`);
      return {
        type: str(r.type ?? "resource", `resources[${i}].type`, 60),
        id: typeof r.id === "string" ? r.id.slice(0, 120) : undefined,
        label: typeof r.label === "string" ? r.label.slice(0, 160) : undefined,
        classification: r.classification as ActionEnvelope["resources"][number]["classification"],
        count: typeof r.count === "number" ? r.count : undefined,
        environment: ["dev", "staging", "production"].includes(r.environment as string) ? (r.environment as "production") : undefined,
      };
    }),
    destination: dest ? { type: dest.type as NonNullable<ActionEnvelope["destination"]>["type"], value: str(dest.value, "destination.value", 200) } : undefined,
    intent: body.intent && typeof body.intent === "object" ? { reason: String((body.intent as Record<string, unknown>).reason ?? "").slice(0, 500), source: (body.intent as Record<string, unknown>).source as "agent" } : undefined,
    business_context: body.business_context && typeof body.business_context === "object" ? (Object.fromEntries(Object.entries(body.business_context as Record<string, unknown>).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 20)) as ActionEnvelope["business_context"]) : undefined,
    signals: body.signals && typeof body.signals === "object" ? (Object.fromEntries(Object.entries(body.signals as Record<string, unknown>).filter(([, v]) => typeof v === "boolean")) as ActionEnvelope["signals"]) : undefined,
    evidence: Array.isArray(body.evidence)
      ? (body.evidence as Array<Record<string, unknown>>).slice(0, 12).map((e, i) => ({ id: `ev_${i + 1}`, label: String(e.label ?? "Evidence").slice(0, 60), value: String(e.value ?? "").slice(0, 300), source: String(e.source ?? "Caller").slice(0, 60), kind: "fact" as const, confidence: (["high", "medium", "low"].includes(e.confidence as string) ? e.confidence : "medium") as "high" }))
      : undefined,
    blast_radius: Array.isArray(body.blast_radius) ? (body.blast_radius as unknown[]).slice(0, 6).map((b) => String(b).slice(0, 200)) : undefined,
    ttl_seconds: ttl,
    callback_url: typeof body.callback_url === "string" ? body.callback_url.slice(0, 500) : undefined,
    requested_at: typeof body.requested_at === "string" ? body.requested_at : undefined,
  };
}
