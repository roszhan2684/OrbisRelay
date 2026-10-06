// Gateway adapter: maps a v1 action envelope onto the canonical endpoint-event/1 shape the edge model
// was trained on, using only information the gateway already holds (tenant allowlist, actor registry).
// Destinations are hashed exactly as the endpoint would hash them — raw values never enter ML state.
import { createHash } from "node:crypto";
import type { ActionEnvelope, Classification } from "@orbis/policy-core";
import { EVENT_SCHEMA } from "./features";

export function domainHash(domain: string | undefined | null): string {
  const d = (domain ?? "").trim().toLowerCase();
  return d ? createHash("sha256").update(d).digest("hex").slice(0, 16) : "";
}

const RANK: Record<Classification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3, regulated: 4 };

/** Privilege per actor, mirroring the actor families in the training generator. */
const PRIVILEGE: Record<string, "standard" | "elevated" | "admin"> = {
  "access-broker": "admin",
  "ap-workflow": "elevated",
  "ci-deployer": "elevated",
  "export-workflow": "elevated",
  "records-exchange": "elevated",
  "facility-ai": "elevated",
  "ops-agent": "elevated",
};

export interface AdapterContext {
  tenant_id: string;
  approved: Set<string>;
  tools: Record<string, Record<string, "low" | "medium" | "high">>;
  managed: boolean;
  tz_offset_minutes?: number;
}

function actionType(env: ActionEnvelope): string {
  const t = env.action.type;
  const dt = env.destination?.type;
  const prod = env.resources.some((r) => r.environment === "production");
  switch (t) {
    case "external_send":
      return dt === "internal_model" || dt === "external_model" ? "model_provider_send" : "external_send";
    case "email_send":
    case "record_release":
      return "external_send";
    case "deploy":
      return prod ? "production_deploy" : "tool_invoke";
    case "grant_access":
      return "privilege_grant";
    case "data_export":
      return "bulk_download";
    case "operational_stop":
      return "physical_operation";
    case "delete":
      return "destructive_delete";
    case "invoke_tool":
      // Action normalization: read-only data tools are database queries, whatever the caller called them.
      return /(^|[._-])(lookup|query|search|select|sql|psql|report)([._-]|$)/.test(env.action.tool ?? "") ? "database_query" : "tool_invoke";
    default:
      return t; // payment, refund, config_change keep their names
  }
}

function destination(env: ActionEnvelope, ctx: AdapterContext): { type: string; trust: string; value?: string } {
  const d = env.destination;
  if (!d) return { type: "none", trust: "trusted" };
  const v = d.value.toLowerCase();
  const approved = ctx.approved.has(v);
  switch (d.type) {
    case "internal":
      return { type: "internal", trust: "trusted", value: v };
    case "internal_model":
      return { type: "internal_model", trust: "trusted", value: v };
    case "environment":
      return { type: "production_env", trust: "trusted", value: v };
    case "external_model":
      return { type: "external_ai_provider", trust: approved ? "approved" : "unverified", value: v };
    case "external_domain":
      return approved ? { type: "approved_vendor", trust: "approved", value: v } : { type: "external_domain", trust: "unverified", value: v };
    case "customer":
      return { type: "external_domain", trust: "approved", value: v };
    case "beneficiary":
    case "partner":
      return { type: d.type, trust: approved ? "approved" : "unverified", value: v };
    default:
      return { type: "unknown", trust: "unknown", value: v };
  }
}

/**
 * Callers often omit a classification for non-document actions (a refund, a deploy). The gateway then
 * infers the class the action inherently touches — never "public" — and the decision record says so.
 */
export function defaultClassification(type: ActionEnvelope["action"]["type"]): Classification {
  if (type === "payment" || type === "refund" || type === "data_export") return "confidential";
  if (type === "record_release") return "regulated";
  return "internal";
}

export function envelopeToEvent(env: ActionEnvelope, at: Date, ctx: AdapterContext): Record<string, unknown> {
  let cls: Classification | undefined;
  let count = 0;
  let environment = "none";
  for (const r of env.resources) {
    if (r.classification && (!cls || RANK[r.classification] > RANK[cls])) cls = r.classification;
    count += r.count ?? 1;
    if (r.environment === "production" || (environment === "none" && r.environment)) environment = r.environment ?? environment;
  }
  const bc = env.business_context ?? {};
  if (typeof bc.record_count === "number") count = Math.max(count, bc.record_count);
  const d = destination(env, ctx);
  const tool = env.action.tool ?? "";
  const actorType = env.actor.type === "workflow" ? "automation" : env.actor.type;
  return {
    schema: EVENT_SCHEMA,
    event_id: `evt_${env.request_id}`.slice(0, 128),
    tenant_id: ctx.tenant_id,
    timestamp: at.toISOString(),
    tz_offset_minutes: ctx.tz_offset_minutes ?? -240,
    endpoint_id: "gateway",
    actor: { id: env.actor.id, type: actorType, owner: env.actor.owner, privilege_level: env.actor.type === "human" ? "standard" : (PRIVILEGE[env.actor.id] ?? "standard") },
    action: { type: actionType(env), tool, tool_risk_class: ctx.tools[env.actor.id]?.[tool] ?? "unknown" },
    resource: { types: env.resources.map((r) => r.type).slice(0, 4), classification: cls ?? defaultClassification(env.action.type), count: Math.min(Math.max(0, Math.round(count)), 10_000_000) },
    destination: d.type === "none" ? { type: "none" } : { type: d.type, trust: d.trust, domain_hash: domainHash(d.value) },
    environment,
    device_posture: ctx.managed ? "managed" : "unmanaged",
    business_context: {
      amount_usd: typeof bc.amount_usd === "number" ? Math.max(0, bc.amount_usd) : 0,
      change_window: env.signals?.outside_change_window === true ? false : typeof bc.change_request === "string" ? true : null,
      ticket: Boolean(bc.ticket || bc.change_request || bc.incident_id),
    },
  };
}
