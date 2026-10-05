import type { Condition, PolicyRule } from "@orbis/policy-core";

export const FIELD_LABEL: Record<string, string> = {
  "actor.type": "actor type",
  "actor.id": "actor",
  "actor.trust": "actor trust",
  "action.type": "action",
  "action.tool": "tool",
  "resource.classification": "data class",
  "resource.classification_rank": "data sensitivity",
  "resource.count": "resource count",
  "resource.environment": "environment",
  "destination.type": "destination type",
  "destination.value": "destination",
  "destination.external": "destination is external",
  "destination.approved": "destination is allowlisted",
  "destination.new": "destination is new",
  amount_usd: "amount (USD)",
  record_count: "record count",
  duration_minutes: "duration (min)",
  "context.incident_active": "incident active",
  "context.change_request": "change request",
  "context.ticket": "ticket",
  "context.justified": "has justification",
  "signals.actor_anomaly": "behaviour anomaly",
  "signals.outside_change_window": "outside change window",
  "signals.tests_passed": "tests passed",
  "time.business_hours": "business hours",
};

const OP: Record<string, string> = { eq: "is", neq: "is not", in: "is one of", not_in: "is not one of", gt: ">", gte: "≥", lt: "<", lte: "≤", exists: "is present", not_exists: "is missing", contains: "contains" };
const RANK = ["public", "internal", "confidential", "restricted", "regulated"];

export function conditionText(c: Condition) {
  const f = FIELD_LABEL[c.field] ?? c.field;
  if (c.op === "exists" || c.op === "not_exists") return `${f} ${OP[c.op]}`;
  let v = Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
  if (c.field === "resource.classification_rank" && typeof c.value === "number") v = `${RANK[c.value]}${c.op === "gte" ? "+" : ""}`;
  if (typeof c.value === "number" && c.field !== "resource.classification_rank") v = c.value.toLocaleString("en-US");
  if (c.value === true && OP[c.op] === "is") return f;
  if (c.value === true && c.op === "neq") return `not ${f}`;
  return `${f} ${c.field === "resource.classification_rank" ? "is" : OP[c.op]} ${String(v).replace(/_/g, " ")}`;
}

export const EFFECT_LABEL: Record<string, string> = {
  allow: "Allow",
  allow_log: "Allow + log",
  warn: "Warn",
  require_confirmation: "Require confirmation",
  require_approval: "Require approval",
  require_quorum: "Require quorum",
  deny: "Deny",
  freeze: "Freeze",
};

export const EFFECT_TONE: Record<string, "low" | "medium" | "high" | "critical" | "cobalt" | "neutral"> = {
  allow: "low",
  allow_log: "low",
  warn: "medium",
  require_confirmation: "cobalt",
  require_approval: "cobalt",
  require_quorum: "cobalt",
  deny: "critical",
  freeze: "critical",
};

export function ruleSignature(r: PolicyRule) {
  return JSON.stringify({ when: r.when, effect: r.effect, route: r.route, step_up: r.step_up, quorum: r.quorum });
}
