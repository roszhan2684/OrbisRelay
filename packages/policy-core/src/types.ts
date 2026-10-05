// Canonical Orbis Relay contracts. Mirrors docs/api/openapi.yaml.

export type ActorType = "human" | "service" | "workflow" | "agent" | "automation";

export type ActionType =
  | "external_send"
  | "email_send"
  | "payment"
  | "refund"
  | "deploy"
  | "grant_access"
  | "data_export"
  | "record_release"
  | "operational_stop"
  | "config_change"
  | "delete"
  | "invoke_tool";

export type Classification = "public" | "internal" | "confidential" | "restricted" | "regulated";
export type Environment = "dev" | "staging" | "production";

export interface ActorRef {
  type: ActorType;
  id: string;
  owner?: string;
  display_name?: string;
}

export interface ActionSpec {
  type: ActionType;
  tool?: string;
  /** Redacted, human-readable summary. Never the raw payload. */
  arguments_summary?: string;
  /** Short verb-first title, e.g. "Send 4 contracts". */
  title?: string;
  /** Structured, display-safe parameters. Editable ones are declared by policy. */
  parameters?: Record<string, string | number | boolean>;
}

export interface ResourceRef {
  type: string;
  id?: string;
  classification?: Classification;
  count?: number;
  environment?: Environment;
  label?: string;
}

export interface Destination {
  type:
    | "internal"
    | "external_domain"
    | "external_model"
    | "internal_model"
    | "beneficiary"
    | "environment"
    | "partner"
    | "customer";
  value: string;
}

export interface ActionEnvelope {
  request_id: string;
  actor: ActorRef;
  action: ActionSpec;
  resources: ResourceRef[];
  destination?: Destination;
  intent?: { reason?: string; source?: "agent" | "human" | "workflow" | "system" };
  business_context?: {
    amount_usd?: number;
    record_count?: number;
    incident_id?: string;
    change_request?: string;
    ticket?: string;
    deal_id?: string;
    duration_minutes?: number;
    [k: string]: string | number | boolean | undefined;
  };
  /** Customer-provided or Orbis-derived contextual signals. */
  signals?: {
    new_destination?: boolean;
    actor_anomaly?: boolean;
    incident_active?: boolean;
    outside_change_window?: boolean;
    tests_passed?: boolean;
    rollback_ready?: boolean;
    fraud_signal?: boolean;
    [k: string]: boolean | undefined;
  };
  evidence?: EvidenceItem[];
  /** What changes if approved, in plain language. */
  blast_radius?: string[];
  requested_at?: string;
  ttl_seconds?: number;
  callback_url?: string;
}

export interface EvidenceItem {
  id: string;
  label: string;
  value: string;
  source: string;
  freshness?: string;
  confidence?: "high" | "medium" | "low";
  kind?: "fact" | "diff" | "history" | "signal" | "link";
}

// ---------- Policy ----------

export type Effect =
  | "allow"
  | "allow_log"
  | "warn"
  | "require_confirmation"
  | "require_approval"
  | "require_quorum"
  | "deny"
  | "freeze";

export const EFFECT_SEVERITY: Record<Effect, number> = {
  allow: 0,
  allow_log: 1,
  warn: 2,
  require_confirmation: 3,
  require_approval: 4,
  require_quorum: 5,
  deny: 6,
  freeze: 7,
};

export type Operator =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists"
  | "contains";

export interface Condition {
  field: string;
  op: Operator;
  value?: string | number | boolean | Array<string | number>;
}

export interface EditableField {
  key: string;
  label: string;
  type: "number" | "string" | "enum" | "duration_minutes";
  min?: number;
  max?: number;
  options?: string[];
}

export interface SafeAlternative {
  id: string;
  type: "redirect" | "redact" | "reduce_scope" | "schedule" | "sandbox";
  label: string;
  description: string;
  /** Parameter overrides applied when the human chooses this alternative. */
  apply: Record<string, string | number | boolean>;
}

export interface PolicyRule {
  id: string;
  name: string;
  description?: string;
  when: { all?: Condition[]; any?: Condition[] };
  effect: Effect;
  /** Plain-language reason shown on the approval card. */
  reason: string;
  route?: string;
  step_up?: "none" | "biometric";
  quorum?: { required: number; of: number };
  editable_fields?: EditableField[];
  safe_alternatives?: SafeAlternative[];
  ttl_seconds?: number;
}

export interface PolicyVersion {
  policy_id: string;
  version: number;
  status: "published" | "draft" | "superseded";
  rules: PolicyRule[];
  change_note: string;
  created_at: string;
  created_by: string;
  published_at?: string;
  checksum?: string;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  pack: string;
  enabled: boolean;
  current_version: number;
  versions: PolicyVersion[];
}

// ---------- Decisions ----------

export type DecisionStatus = "allow" | "warn" | "deny" | "approval_required";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskReason {
  code: string;
  label: string;
  weight: number;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
}

export interface MatchedRule {
  policy_id: string;
  policy_name: string;
  version: number;
  rule_id: string;
  rule_name: string;
  effect: Effect;
  reason: string;
}

export interface Evaluation {
  status: DecisionStatus;
  effect: Effect;
  frozen: boolean;
  risk: RiskAssessment;
  matched: MatchedRule[];
  /** The rule that determined the outcome (most severe). */
  deciding?: MatchedRule;
  approval?: {
    route: string;
    step_up: "none" | "biometric";
    quorum?: { required: number; of: number };
    ttl_seconds: number;
    editable_fields: EditableField[];
  };
  safe_alternatives: SafeAlternative[];
  facts: Facts;
}

export type FactValue = string | number | boolean | undefined;
export type Facts = Record<string, FactValue>;

export interface EvaluationContext {
  now: Date;
  frozenActors: Set<string>;
  /** Destinations the tenant has explicitly approved (domains, models, beneficiaries). */
  approvedDestinations: Set<string>;
  /** Destinations seen before for this tenant. Unknown ones are "new". */
  knownDestinations?: Set<string>;
  actorTrust?: Record<string, "trusted" | "new" | "watch">;
  businessHours?: { start: number; end: number; timezoneOffsetMinutes: number };
}
