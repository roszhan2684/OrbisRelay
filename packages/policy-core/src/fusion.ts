// Policy + ML decision fusion (blueprint §25). Pure and deterministic.
//
// Deterministic policy is the final authority. The ML signal can only *raise* the outcome
// (allow → warn → approval_required), never lower it, and is ignored when unavailable, stale,
// incompatible or disabled. Every fused decision records which rule of this table applied.

import type { DecisionStatus, Effect } from "./types";

export type MlClass = "safe_normal" | "safe_unusual" | "suspicious_review" | "high_risk";

export interface MlSignal {
  /** local = endpoint runtime, cloud = gateway-side port, both = both present and agreeing on severity. */
  source: "local" | "cloud" | "local+cloud";
  model_version: string;
  feature_schema: string;
  class: MlClass;
  risk: number;
  abstain: boolean;
  ood: boolean;
  high_impact: boolean;
  reasons: Array<{ code: string; label: string }>;
  anomaly?: number | null;
}

export interface MlAvailability {
  available: boolean;
  /** Why the model was not consulted (fallback). */
  reason?: "kill_switch" | "model_unavailable" | "stale_model" | "incompatible_schema" | "disabled" | "inference_error";
}

export interface FusionPolicy {
  /** off: never consulted. advisory: recorded and shown, never changes the outcome. escalate: may raise. */
  mode: "off" | "advisory" | "escalate";
  /** Classes that raise allow/warn to approval_required. */
  approval_classes: MlClass[];
  /** Classes that raise allow to warn. */
  warn_classes: MlClass[];
  /** Abstained (uncertain / out-of-distribution) high-impact actions go to a human. */
  escalate_abstain_high_impact: boolean;
  route: string;
}

export const DEFAULT_FUSION_POLICY: FusionPolicy = {
  mode: "escalate",
  approval_classes: ["high_risk"],
  warn_classes: ["suspicious_review"],
  escalate_abstain_high_impact: true,
  route: "security",
};

export type FusionRule =
  | "hard_deny_wins"
  | "deterministic_approval_wins"
  | "model_unavailable_fallback"
  | "fusion_off"
  | "advisory_only"
  | "model_escalated_to_approval"
  | "model_raised_to_warn"
  | "abstain_high_impact_escalated"
  | "deterministic_stands";

export interface FusionResult {
  status: DecisionStatus;
  effect: Effect;
  rule: FusionRule;
  changed: boolean;
  reason: string;
  route?: string;
}

const RANK: Record<DecisionStatus, number> = { allow: 0, warn: 1, approval_required: 2, deny: 3 };

export function fuse(
  deterministic: { status: DecisionStatus; effect: Effect; frozen: boolean },
  signal: MlSignal | null,
  availability: MlAvailability,
  policy: FusionPolicy = DEFAULT_FUSION_POLICY,
): FusionResult {
  const keep = (rule: FusionRule, reason: string): FusionResult => ({ status: deterministic.status, effect: deterministic.effect, rule, changed: false, reason });

  if (deterministic.frozen || deterministic.status === "deny") return keep("hard_deny_wins", "Deterministic deny/freeze is final; the model is not consulted.");
  if (deterministic.status === "approval_required") return keep("deterministic_approval_wins", "Policy already requires a human; the model signal is attached as evidence only.");
  if (policy.mode === "off") return keep("fusion_off", "Model escalation is turned off for this tenant.");
  if (!availability.available || !signal) return keep("model_unavailable_fallback", `Model not consulted (${availability.reason ?? "unavailable"}); deterministic policy decided.`);
  if (policy.mode === "advisory") return keep("advisory_only", "Advisory mode: the model signal is recorded and shown but cannot change the outcome.");

  const raise = (status: DecisionStatus, effect: Effect, rule: FusionRule, reason: string): FusionResult =>
    RANK[status] > RANK[deterministic.status]
      ? { status, effect, rule, changed: true, reason, route: status === "approval_required" ? policy.route : undefined }
      : keep("deterministic_stands", "The model agreed with or was less severe than policy; policy stands.");

  if (policy.approval_classes.includes(signal.class)) {
    return raise("approval_required", "require_approval", "model_escalated_to_approval", `Edge risk model classified this ${signal.class.replace("_", " ")} (risk ${signal.risk.toFixed(2)}).`);
  }
  if (signal.abstain && signal.high_impact && policy.escalate_abstain_high_impact) {
    return raise("approval_required", "require_approval", "abstain_high_impact_escalated", signal.ood ? "Unrecognised fields on a high-impact action — routed to a human instead of guessing." : "The model was uncertain about a high-impact action — routed to a human.");
  }
  if (policy.warn_classes.includes(signal.class)) {
    return raise("warn", "warn", "model_raised_to_warn", `Edge risk model flagged this as ${signal.class.replace("_", " ")}.`);
  }
  return keep("deterministic_stands", "The model did not raise the outcome; policy stands.");
}

/** Combine an endpoint (local) and a gateway (cloud) signal: the more severe one wins. */
export function combineSignals(local: MlSignal | null, cloud: MlSignal | null): MlSignal | null {
  if (!local) return cloud;
  if (!cloud) return local;
  const sev = (s: MlSignal) => ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"].indexOf(s.class) * 10 + (s.abstain && s.high_impact ? 5 : 0) + s.risk;
  const top = sev(local) >= sev(cloud) ? local : cloud;
  return { ...top, source: "local+cloud" };
}
