// Domain records for Orbis Relay (blueprint §11). Shared by server and UI.
import type {
  ActionEnvelope,
  EditableField,
  Effect,
  EvidenceItem,
  MatchedRule,
  Policy,
  RiskAssessment,
  SafeAlternative,
  DecisionStatus,
  ActorType,
} from "@orbis/policy-core";

export type Role = "owner" | "admin" | "policy_admin" | "approver" | "auditor" | "developer" | "responder";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  region: string;
  plan: "Developer" | "Team" | "Business" | "Enterprise";
  retention_days: number;
  created_at: string;
  settings: {
    timezone: string;
    business_hours: { start: number; end: number };
    policy_publish_requires_second_approver: boolean;
    metadata_only_mode: boolean;
    sso: { provider: string; enabled: boolean; domain: string };
    scim: boolean;
    notification_policy: "minimal_summary" | "title_only";
    data_region: string;
  };
  usage: { decisions_this_month: number; included_decisions: number };
}

export interface User {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  title: string;
  roles: Role[];
  groups: string[];
  initials: string;
  color: string;
  status: "active" | "suspended";
}

export interface Device {
  id: string;
  user_id: string;
  name: string;
  model: string;
  os: string;
  registered_at: string;
  last_seen_at: string;
  trust: "managed" | "registered" | "revoked";
  push: boolean;
  biometric: "face_id" | "touch_id" | "none";
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  hash: string;
  environment: "production" | "sandbox";
  scopes: string[];
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

export interface Integration {
  id: string;
  tenant_id: string;
  name: string;
  vendor: string;
  kind: "agent_platform" | "workflow" | "saas" | "internal" | "ci" | "sandbox";
  description: string;
  mode: "enforce" | "observe";
  status: "healthy" | "degraded" | "paused";
  created_at: string;
  first_protected_at?: string;
  last_seen_at?: string;
  actor_ids: string[];
  api_keys: ApiKey[];
  webhook_id?: string;
  sdk: string;
}

export interface Actor {
  id: string;
  tenant_id: string;
  type: ActorType;
  name: string;
  description: string;
  owner_team: string;
  integration_id: string;
  trust: "trusted" | "new" | "watch";
  baseline_per_hour: number;
  tools: Array<{ tool: string; risk_class: "low" | "medium" | "high" }>;
  created_at: string;
}

export type FinalStatus =
  | "allow"
  | "warn"
  | "deny"
  | "pending"
  | "approved"
  | "approved_modified"
  | "rejected"
  | "expired"
  | "cancelled";

export type OutcomeStatus = "succeeded" | "failed" | "not_executed" | "unknown";

export interface ActionRecord {
  id: string;
  tenant_id: string;
  integration_id: string;
  request_id: string;
  envelope: ActionEnvelope;
  envelope_hash: string;
  received_at: string;
  decided_at: string;
  latency_ms: number;
  mode: "enforce" | "observe";
  evaluation: {
    status: DecisionStatus;
    effect: Effect;
    frozen: boolean;
    risk: RiskAssessment;
    matched: MatchedRule[];
    deciding?: MatchedRule;
    policy_versions: Array<{ policy_id: string; version: number }>;
    /** What deterministic policy alone decided, before ML fusion (§25). */
    deterministic_status?: DecisionStatus;
    fusion?: { rule: string; changed: boolean; reason: string };
  };
  prediction_id?: string;
  decision_id: string;
  final_status: FinalStatus;
  approval_id?: string;
  receipt_id?: string;
  approved_parameters?: Record<string, string | number | boolean>;
  safe_alternative_applied?: string;
  outcome?: { status: OutcomeStatus; reported_at: string; detail?: string };
}

export interface ApprovalResponse {
  id: string;
  user_id: string;
  user_name: string;
  decision: "approve" | "approve_modified" | "reject" | "safe_alternative";
  alternative_id?: string;
  modified_parameters?: Record<string, string | number | boolean>;
  comment?: string;
  step_up: { method: "biometric" | "passkey" | "none"; verified: boolean; device_id?: string };
  channel: "ios" | "web";
  responded_at: string;
  unnecessary?: boolean;
}

export type ApprovalStatus = "pending" | "approved" | "approved_modified" | "rejected" | "expired" | "cancelled";

export interface ApprovalRecord {
  id: string;
  tenant_id: string;
  action_id: string;
  title: string;
  summary: string;
  intent?: string;
  route: string;
  assignees: string[];
  status: ApprovalStatus;
  step_up: "none" | "biometric";
  quorum?: { required: number; of: number };
  created_at: string;
  expires_at: string;
  resolved_at?: string;
  escalation_level: number;
  escalated_at?: string;
  responses: ApprovalResponse[];
  editable_fields: EditableField[];
  safe_alternatives: SafeAlternative[];
  evidence: EvidenceItem[];
  blast_radius: string[];
  risk: RiskAssessment;
  policy: { id: string; name: string; version: number; rule_id: string; rule_name: string; reason: string };
  actor: { id: string; type: ActorType; name: string };
  integration: { id: string; name: string };
  parameters: Record<string, string | number | boolean>;
  delegation?: { from_user: string; to_user: string; until: string };
  /** Edge-risk evidence shown to the approver (blueprint §16). */
  ml?: ApprovalMl;
}

export interface ApprovalMl {
  source: "local" | "cloud" | "local+cloud";
  model_version: string;
  runtime: string;
  class: string;
  risk: number;
  abstain: boolean;
  reasons: Array<{ code: string; label: string }>;
  explanation: string;
  anomaly: number | null;
  anomaly_top: string[];
  baseline: string;
  fusion_rule: string;
  model_health: string;
}

// ---------------------------------------------------------------- ML (Orbis Endpoint Intelligence)

export type MlLabel = "safe_normal" | "safe_unusual" | "suspicious_review" | "high_risk";
export type ModelStatus = "trained" | "evaluated" | "candidate" | "shadow" | "canary" | "production" | "deprecated" | "retired" | "rejected";

export interface MlPrediction {
  id: string;
  action_id: string;
  actor_id: string;
  at: string;
  source: "local" | "cloud" | "local+cloud" | "fallback";
  model_version: string | null;
  policy_version: string | null;
  feature_schema: string;
  canonical_action: string;
  class: MlLabel | null;
  risk: number | null;
  probs: number[] | null;
  abstain: boolean;
  ood: boolean;
  guarded: boolean;
  high_impact: boolean;
  reasons: Array<{ code: string; label: string }>;
  explanation: string;
  anomaly: { score: number; sufficient: boolean; top: string[] };
  /** Endpoint-reported signal, kept separately for integrity checks against the cloud score. */
  local?: { endpoint_id: string; model_version: string; runtime: string; class: MlLabel; risk: number; inference_us?: number; agreed: boolean };
  shadow?: { model_version: string; class: MlLabel; risk: number };
  /** Snapshot of drift-monitored features (see DRIFT_FEATURES). */
  drift: number[];
  deterministic_status: DecisionStatus;
  fusion: { rule: string; changed: boolean; reason: string };
  fallback?: string;
}

export interface MlFeedback {
  id: string;
  prediction_id: string;
  action_id: string;
  label: MlLabel;
  label_state: "gold_confirmed" | "analyst_reviewed" | "human_decision_proxy" | "weak_label";
  confidence: number;
  source: "analyst" | "approval" | "outcome";
  reviewed_by: string;
  reviewed_at: string;
  note?: string;
}

export interface ModelLifecycleEvent {
  at: string;
  version: string;
  to: ModelStatus;
  percent?: number;
  by: string;
  reason: string;
  automatic?: boolean;
}

export interface MlModelRecord {
  version: string;
  status: ModelStatus;
  rollout_percent: number;
  created_at: string;
  history: ModelLifecycleEvent[];
}

export interface EndpointRecord {
  id: string;
  name: string;
  kind: "agent_host" | "developer_mac" | "ci_runner";
  os: string;
  app_version: string;
  owner: string;
  integration_id?: string;
  bucket: number;
  model_version: string | null;
  feature_schema: string;
  last_update_at: string | null;
  last_seen_at: string;
  signature: "verified" | "failed" | "not_checked";
  state: "healthy" | "degraded" | "stale" | "incompatible" | "offline" | "revoked";
  health: { inference_p95_ms: number; pipeline_p95_ms: number; memory_mb: number; cpu_percent: number; queue_depth: number; failures_24h: number; fallbacks_24h: number };
  telemetry: { events_24h: number; high_priority_24h: number; dropped_24h: number };
  /** true when registered by a real orbis-endpoint process; false for the simulated demo fleet. */
  real: boolean;
  note?: string;
}

export interface MlState {
  fusion: import("@orbis/policy-core").FusionPolicy;
  kill_switch: boolean;
  models: MlModelRecord[];
  manifest_seq: number;
  signing_key: { id: string; private_pem: string; public_pem: string; x: string };
  endpoints: EndpointRecord[];
  activations: Array<{ endpoint_id: string; version: string; activated: boolean; error?: string; at: string; compile_ms?: number }>;
  baselines: Record<string, import("./ml/edge/features").ActorState>;
  predictions: MlPrediction[];
  feedback: MlFeedback[];
}

export interface ReceiptBody {
  receipt_id: string;
  revision: number;
  tenant_id: string;
  decision_id: string;
  action_id: string;
  request_id: string;
  issued_at: string;
  caller: { integration_id: string; integration_name: string };
  actor: { id: string; type: string; owner?: string };
  action: { type: string; tool?: string; title?: string; summary?: string };
  envelope_hash: string;
  policy: { id: string; version: number; rule_id: string } | null;
  policy_versions: Array<{ policy_id: string; version: number }>;
  risk: { score: number; level: string; reasons: string[] };
  enrichment: {
    used: boolean;
    model?: string;
    feature_schema?: string;
    policy_version?: string;
    source?: string;
    class?: string;
    risk?: number;
    abstain?: boolean;
    fusion_rule?: string;
    fallback?: string;
  };
  decision: { status: string; effect: string; final_status: FinalStatus };
  approvals: Array<{ user_id: string; name: string; decision: string; step_up: string; device_id?: string; at: string; channel: string }>;
  original_parameters: Record<string, string | number | boolean>;
  approved_parameters?: Record<string, string | number | boolean>;
  safe_alternative_applied?: string;
  timestamps: { received_at: string; decided_at: string; resolved_at?: string };
  outcome?: { status: OutcomeStatus; reported_at: string };
  prev_hash?: string;
}

export interface Receipt {
  id: string;
  tenant_id: string;
  action_id: string;
  revision: number;
  body: ReceiptBody;
  body_hash: string;
  signature: string;
  key_id: string;
  alg: "Ed25519";
}

export interface WebhookEndpoint {
  id: string;
  integration_id: string;
  url: string;
  secret_hint: string;
  events: string[];
  status: "active" | "failing" | "disabled";
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  action_id?: string;
  status_code: number;
  attempt: number;
  delivered_at: string;
  duration_ms: number;
}

export interface Freeze {
  id: string;
  tenant_id: string;
  actor_id: string;
  reason: string;
  created_by: string;
  created_at: string;
  channel: "ios" | "web" | "api";
  lifted_at?: string;
  lifted_by?: string;
  lift_reason?: string;
  blocked_count: number;
}

export interface AuditEvent {
  id: string;
  seq: number;
  tenant_id: string;
  at: string;
  type: string;
  actor: { kind: "user" | "integration" | "system"; id: string; name: string };
  target?: { type: string; id: string };
  summary: string;
  data?: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface ProtectAnalysis {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: "url" | "text" | "qr" | "screenshot";
  input_preview: string;
  verdict: "safe" | "caution" | "dangerous";
  score: number;
  recommendation: string;
  reasons: Array<{ label: string; detail: string; weight: "high" | "medium" | "low" | "positive" }>;
  model: { name: string; version: string; probability: number }[];
  policy_note?: string;
  created_at: string;
  channel: "ios" | "web";
}

export interface DB {
  version: number;
  /** Shared epoch (serverless sync) this replica was seeded from. */
  epoch_id?: string;
  seeded_at: string;
  signing_key: { id: string; private_pem: string; public_pem: string; x: string };
  tenant: Tenant;
  users: User[];
  devices: Device[];
  integrations: Integration[];
  actors: Actor[];
  policies: Policy[];
  actions: ActionRecord[];
  approvals: ApprovalRecord[];
  receipts: Receipt[];
  webhooks: WebhookEndpoint[];
  deliveries: WebhookDelivery[];
  freezes: Freeze[];
  audit: AuditEvent[];
  protect: ProtectAnalysis[];
  sessions: Array<{ token_hash: string; user_id: string; device_id?: string; created_at: string; kind: "console" | "mobile" }>;
  approved_destinations: string[];
  known_destinations: string[];
  ml: MlState;
}

export type { ActionEnvelope, EvidenceItem, Policy, RiskAssessment, SafeAlternative, EditableField };
