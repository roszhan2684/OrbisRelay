import type { Policy, PolicyRule } from "./types";

// Default Northstar Cloud policy set. Each policy carries real version history so the
// console can show diffs and the simulator can replay drafts against live traffic.


const confRules = (v: number): PolicyRule[] => [
  {
    id: "ext_model_confidential",
    name: "Confidential data → unapproved AI provider",
    description: "Agents may not send confidential or higher data to model providers outside the approved trust boundary.",
    when: {
      all: [
        { field: "destination.type", op: "eq", value: "external_model" },
        { field: "resource.classification_rank", op: "gte", value: 2 },
        { field: "destination.approved", op: "neq", value: true },
      ],
    },
    effect: v >= 17 ? "require_approval" : "warn",
    reason: "Confidential data would leave the approved AI trust boundary.",
    route: "ai-governance",
    step_up: "biometric",
    ttl_seconds: 600,
    safe_alternatives: [
      {
        id: "redirect_internal_model",
        type: "redirect",
        label: "Redirect to Approved Internal Model",
        description: "Run the same task on Northstar Private LLM (us-east-1, zero retention, SOC 2 boundary).",
        apply: { destination: "northstar-private-llm" },
      },
    ],
  },
  {
    id: "ext_domain_confidential",
    name: "Confidential documents → external domain",
    when: {
      all: [
        { field: "destination.type", op: "eq", value: "external_domain" },
        { field: "resource.classification_rank", op: "gte", value: 2 },
        { field: "destination.approved", op: "neq", value: true },
      ],
    },
    effect: "require_approval",
    reason: "Confidential documents addressed to a domain that is not on the partner allowlist.",
    route: "security",
    step_up: "biometric",
    safe_alternatives: [
      {
        id: "share_secure_room",
        type: "redirect",
        label: "Share via secure data room",
        description: "Send an expiring, watermarked link instead of attachments.",
        apply: { delivery: "secure-room-link" },
      },
    ],
  },
  ...(v >= 18
    ? [
        {
          id: "approved_model_low_friction",
          name: "Approved models stay autonomous",
          when: {
            all: [
              { field: "destination.type", op: "eq", value: "internal_model" },
              { field: "destination.approved", op: "eq", value: true },
            ],
          },
          effect: "allow_log",
          reason: "Approved internal model; logged for audit only.",
        } satisfies PolicyRule,
        {
          id: "restricted_never_external",
          name: "Restricted data never leaves",
          when: {
            all: [
              { field: "destination.external", op: "eq", value: true },
              { field: "resource.classification", op: "eq", value: "restricted" },
            ],
          },
          effect: "deny",
          reason: "Restricted data may not be transmitted outside Northstar under any approval.",
        } satisfies PolicyRule,
      ]
    : []),
];

const paymentRules: PolicyRule[] = [
  {
    id: "new_beneficiary_high",
    name: "New beneficiary over $10k",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "payment" },
        { field: "amount_usd", op: "gte", value: 10_000 },
        { field: "destination.approved", op: "neq", value: true },
      ],
    },
    effect: "require_approval",
    reason: "First payment to an unverified beneficiary above the $10,000 autonomous threshold.",
    route: "finance-controller",
    step_up: "biometric",
    editable_fields: [{ key: "amount_usd", label: "Amount (USD)", type: "number", min: 0 }],
    safe_alternatives: [
      {
        id: "verify_then_pay",
        type: "reduce_scope",
        label: "Pay $1 verification deposit first",
        description: "Confirm beneficiary bank details with a $1 micro-deposit before releasing funds.",
        apply: { amount_usd: 1, hold_remaining: true },
      },
    ],
  },
  {
    id: "extreme_payment_quorum",
    name: "Payments ≥ $250k need two controllers",
    when: { all: [{ field: "action.type", op: "eq", value: "payment" }, { field: "amount_usd", op: "gte", value: 250_000 }] },
    effect: "require_quorum",
    quorum: { required: 2, of: 3 },
    reason: "Extreme-value payment requires two of three authorized controllers.",
    route: "finance-controller",
    step_up: "biometric",
  },
  {
    id: "known_vendor_small",
    name: "Known vendors under $10k",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "payment" },
        { field: "amount_usd", op: "lt", value: 10_000 },
        { field: "destination.approved", op: "eq", value: true },
      ],
    },
    effect: "allow_log",
    reason: "Routine payment to a verified vendor.",
  },
];

const refundRules: PolicyRule[] = [
  {
    id: "refund_over_threshold",
    name: "Refund above $2,500",
    when: { all: [{ field: "action.type", op: "eq", value: "refund" }, { field: "amount_usd", op: "gt", value: 2_500 }] },
    effect: "require_approval",
    reason: "Refund exceeds the $2,500 autonomous support threshold.",
    route: "support-manager",
    step_up: "none",
    editable_fields: [{ key: "amount_usd", label: "Refund amount (USD)", type: "number", min: 0, max: 50_000 }],
    safe_alternatives: [
      {
        id: "service_credit",
        type: "reduce_scope",
        label: "Issue as service credit",
        description: "Apply the amount as account credit instead of a card refund.",
        apply: { method: "service_credit" },
      },
    ],
  },
  {
    id: "refund_warn",
    name: "Refund $500–$2,500",
    when: { all: [{ field: "action.type", op: "eq", value: "refund" }, { field: "amount_usd", op: "gt", value: 500 }] },
    effect: "warn",
    reason: "Refund above $500 — allowed, support lead notified.",
  },
  {
    id: "refund_hard_cap",
    name: "Refund hard cap",
    when: { all: [{ field: "action.type", op: "eq", value: "refund" }, { field: "amount_usd", op: "gt", value: 50_000 }] },
    effect: "deny",
    reason: "Refunds above $50,000 must go through finance, not support automation.",
  },
];

const prodRules = (v: number): PolicyRule[] => [
  {
    id: "prod_outside_window",
    name: "Production deploy outside change window",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "deploy" },
        { field: "resource.environment", op: "eq", value: "production" },
        { field: "signals.outside_change_window", op: "eq", value: true },
      ],
    },
    effect: "require_approval",
    reason: "Production change requested outside the approved change window.",
    route: "eng-oncall",
    step_up: "biometric",
    editable_fields: [{ key: "window_minutes", label: "Change window (minutes)", type: "duration_minutes", min: 5, max: 60 }],
    safe_alternatives: [
      {
        id: "next_window",
        type: "schedule",
        label: "Schedule for next change window",
        description: "Queue the deploy for the 02:00 UTC window with automatic rollback armed.",
        apply: { scheduled_for: "next_window" },
      },
    ],
  },
  {
    id: "prod_failing_tests",
    name: "Block deploys with failing tests",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "deploy" },
        { field: "resource.environment", op: "eq", value: "production" },
        { field: "signals.tests_passed", op: "eq", value: false },
      ],
    },
    effect: "deny",
    reason: "Required checks are failing; production deploy is blocked.",
  },
  {
    id: "prod_in_window",
    name: "In-window production deploys",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "deploy" },
        { field: "resource.environment", op: "eq", value: "production" },
        { field: "signals.outside_change_window", op: "neq", value: true },
      ],
    },
    effect: v >= 12 ? "allow_log" : "warn",
    reason: "Deploy inside an approved change window.",
  },
];

const accessRules: PolicyRule[] = [
  {
    id: "prod_admin_access",
    name: "Production admin access",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "grant_access" },
        { field: "resource.environment", op: "eq", value: "production" },
      ],
    },
    effect: "require_approval",
    reason: "Privileged production access requires manager approval and auto-expiry.",
    route: "eng-manager",
    step_up: "biometric",
    editable_fields: [{ key: "duration_minutes", label: "Access duration (minutes)", type: "duration_minutes", min: 5, max: 60 }],
    safe_alternatives: [
      {
        id: "read_only",
        type: "reduce_scope",
        label: "Grant read-only replica access",
        description: "Read-only access to the analytics replica, no approval required.",
        apply: { role: "db_readonly_replica" },
      },
    ],
  },
  {
    id: "access_too_long",
    name: "No standing privileged access",
    when: { all: [{ field: "action.type", op: "eq", value: "grant_access" }, { field: "duration_minutes", op: "gt", value: 240 }] },
    effect: "deny",
    reason: "Privileged grants longer than 4 hours are never permitted.",
  },
];

const exportRules: PolicyRule[] = [
  {
    id: "bulk_export_block",
    name: "Bulk sensitive export without ticket",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "data_export" },
        { field: "record_count", op: "gte", value: 10_000 },
        { field: "resource.classification_rank", op: "gte", value: 2 },
        { field: "context.ticket", op: "not_exists" },
      ],
    },
    effect: "deny",
    reason: "Bulk export of sensitive records is blocked by default. File an exception ticket to request review.",
  },
  {
    id: "bulk_export_exception",
    name: "Bulk export exception (data owner + security)",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "data_export" },
        { field: "record_count", op: "gte", value: 10_000 },
        { field: "context.ticket", op: "exists" },
      ],
    },
    effect: "require_quorum",
    quorum: { required: 2, of: 2 },
    reason: "Exception export requires both the data owner and security.",
    route: "data-owner",
    step_up: "biometric",
    safe_alternatives: [
      {
        id: "pseudonymize",
        type: "redact",
        label: "Export pseudonymized dataset",
        description: "Hash emails/phones and drop free-text fields; no approval needed.",
        apply: { transform: "pseudonymize" },
      },
    ],
  },
];

const salesRules: PolicyRule[] = [
  {
    id: "nonpublic_pricing",
    name: "Non-public pricing to external recipient",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "email_send" },
        { field: "destination.external", op: "eq", value: true },
        { field: "resource.classification_rank", op: "gte", value: 2 },
      ],
    },
    effect: "require_approval",
    reason: "Agent-drafted email contains confidential pricing for an external recipient.",
    route: "sales-leader",
    step_up: "none",
    safe_alternatives: [
      {
        id: "auto_redact",
        type: "redact",
        label: "Auto-redact restricted sections",
        description: "Strip the discount schedule and send the public price sheet.",
        apply: { redact: "pricing_tiers" },
      },
    ],
  },
];

const regulatedRules: PolicyRule[] = [
  {
    id: "phi_release",
    name: "Regulated records → external partner",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "record_release" },
        { field: "resource.classification", op: "eq", value: "regulated" },
        { field: "destination.external", op: "eq", value: true },
      ],
    },
    effect: "require_approval",
    reason: "Regulated health records leaving Northstar require a privacy officer with documented purpose.",
    route: "privacy",
    step_up: "biometric",
    editable_fields: [{ key: "record_limit", label: "Record limit", type: "number", min: 1 }],
  },
  {
    id: "phi_large_batch",
    name: "Large regulated batch quorum",
    when: {
      all: [
        { field: "action.type", op: "eq", value: "record_release" },
        { field: "record_count", op: "gte", value: 25_000 },
      ],
    },
    effect: "require_quorum",
    quorum: { required: 2, of: 3 },
    reason: "Batches over 25,000 regulated records need two privacy approvers.",
    route: "privacy",
    step_up: "biometric",
  },
];

const opsRules: PolicyRule[] = [
  {
    id: "line_stop",
    name: "Operational stop recommendation",
    when: { all: [{ field: "action.type", op: "eq", value: "operational_stop" }] },
    effect: "require_approval",
    reason: "Stopping physical infrastructure has high operational impact and needs the site manager.",
    route: "facility-ops",
    step_up: "none",
    safe_alternatives: [
      {
        id: "reduce_load",
        type: "reduce_scope",
        label: "Reduce load to 40% instead",
        description: "Shift workloads to DC-West and run chiller line 2 at reduced load while maintenance is scheduled.",
        apply: { mode: "reduced_load_40" },
      },
    ],
  },
];

const agentRules: PolicyRule[] = [
  {
    id: "agent_anomaly",
    name: "Agent behaviour anomaly",
    when: { all: [{ field: "actor.type", op: "eq", value: "agent" }, { field: "signals.actor_anomaly", op: "eq", value: true }] },
    effect: "warn",
    reason: "Agent activity is outside its 14-day baseline; security has been notified.",
  },
  {
    id: "agent_prod_delete",
    name: "Agents cannot delete in production",
    when: {
      all: [
        { field: "actor.type", op: "eq", value: "agent" },
        { field: "action.type", op: "eq", value: "delete" },
        { field: "resource.environment", op: "eq", value: "production" },
      ],
    },
    effect: "deny",
    reason: "Destructive production operations are never delegated to agents.",
  },
  {
    id: "agent_low_risk_tools",
    name: "Low-sensitivity tool calls",
    when: {
      all: [
        { field: "actor.type", op: "eq", value: "agent" },
        { field: "action.type", op: "eq", value: "invoke_tool" },
        { field: "resource.classification_rank", op: "lte", value: 1 },
      ],
    },
    effect: "allow_log",
    reason: "Internal/public data tool call — autonomous, logged.",
  },
];

function policy(
  day: (n: number) => string,
  id: string,
  name: string,
  description: string,
  pack: string,
  versions: Array<{ v: number; rules: PolicyRule[]; note: string; by: string; d: number; status?: "draft" }>,
): Policy {
  const published = versions.filter((x) => x.status !== "draft");
  const current = Math.max(...published.map((x) => x.v));
  return {
    id,
    name,
    description,
    pack,
    enabled: true,
    current_version: current,
    versions: versions.map((x) => ({
      policy_id: id,
      version: x.v,
      status: x.status === "draft" ? "draft" : x.v === current ? "published" : "superseded",
      rules: x.rules,
      change_note: x.note,
      created_at: day(x.d),
      created_by: x.by,
      published_at: x.status === "draft" ? undefined : day(x.d),
    })),
  };
}

/**
 * Build the default policy set. Version dates are expressed as day offsets from `base`
 * (day 94 ≈ yesterday when base = now − 95 days) so seeded history stays realistic on any date.
 */
export function buildDefaultPolicies(base: Date = new Date(Date.UTC(2026, 6, 1))): Policy[] {
  const day = (n: number) => new Date(base.getTime() + n * 86_400_000).toISOString();
  return [
  policy(day, "pol_conf_external", "Confidential data egress", "Controls confidential and restricted data leaving Northstar's approved trust boundary, including AI providers.", "AI & Data", [
    { v: 16, rules: confRules(16), note: "Warn-only rollout for external model sends", by: "avery.kim", d: 40 },
    { v: 17, rules: confRules(17), note: "Enforce: require approval + biometric for unapproved AI providers", by: "avery.kim", d: 78 },
    { v: 18, rules: confRules(18), note: "Draft: auto-allow approved internal model, hard-deny restricted egress", by: "alex.chen", d: 94, status: "draft" },
  ]),
  policy(day, "pol_payments", "Payments & payouts", "Step-up approval for new beneficiaries and extreme-value payments.", "Finance", [
    { v: 8, rules: paymentRules.slice(0, 1), note: "Initial beneficiary rule", by: "jordan.patel", d: 12 },
    { v: 9, rules: paymentRules, note: "Add quorum for ≥ $250k and auto-allow known vendors", by: "jordan.patel", d: 60 },
  ]),
  policy(day, "pol_refunds", "Customer refunds", "Keeps support automation fast for small refunds, escalates large ones.", "Support", [
    { v: 5, rules: refundRules, note: "Raise autonomous threshold to $2,500", by: "sam.rivera", d: 70 },
  ]),
  policy(day, "pol_prod_change", "Production change control", "Change-window enforcement for production deploys.", "Engineering", [
    { v: 11, rules: prodRules(11), note: "Warn on in-window deploys", by: "riley.okafor", d: 30 },
    { v: 12, rules: prodRules(12), note: "In-window deploys become autonomous (allow+log)", by: "riley.okafor", d: 82 },
  ]),
  policy(day, "pol_privileged_access", "Privileged access", "Just-in-time, auto-expiring privileged access with biometric step-up.", "Identity", [
    { v: 7, rules: accessRules, note: "Cap duration at 4h, step-up required", by: "avery.kim", d: 55 },
  ]),
  policy(day, "pol_bulk_export", "Bulk data export", "Blocks bulk sensitive exports by default; exceptions need data owner + security.", "AI & Data", [
    { v: 4, rules: exportRules, note: "Ticketed exception path with 2-of-2 quorum", by: "casey.nguyen", d: 64 },
  ]),
  policy(day, "pol_sales_comms", "External sales communications", "Prevents agents from sending non-public pricing externally.", "Sales", [
    { v: 3, rules: salesRules, note: "Auto-redact alternative", by: "morgan.lee", d: 50 },
  ]),
  policy(day, "pol_regulated", "Regulated data transfer", "Privacy officer approval for regulated (HIPAA) record releases.", "Compliance", [
    { v: 6, rules: regulatedRules, note: "Quorum for batches > 25k", by: "casey.nguyen", d: 45 },
  ]),
  policy(day, "pol_ops_safety", "Operational safety", "Facility automation recommendations that stop physical systems.", "Operations", [
    { v: 2, rules: opsRules, note: "Reduced-load alternative", by: "taylor.brooks", d: 35 },
  ]),
  policy(day, "pol_agent_guardrails", "Agent baseline guardrails", "Baseline controls applied to every registered AI agent.", "AI & Data", [
    { v: 10, rules: agentRules.slice(0, 2), note: "Anomaly + prod delete", by: "alex.chen", d: 20 },
    { v: 11, rules: agentRules, note: "Low-sensitivity tool calls stay autonomous", by: "alex.chen", d: 72 },
  ]),
  ];
}

export const DEFAULT_POLICIES: Policy[] = buildDefaultPolicies();

export const APPROVED_DESTINATIONS = [
  "northstar-private-llm",
  "northstar.cloud",
  "acme-supplies.com",
  "globex-logistics.com",
  "initech-hardware.com",
  "carelink-hie.org",
  "stripe-payouts:acct_northstar",
];
