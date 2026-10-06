import "server-only";
import { APPROVED_DESTINATIONS, buildDefaultPolicies, DEFAULT_FUSION_POLICY, type ActionEnvelope, type Policy } from "@orbis/policy-core";
import type { Actor, ApprovalRecord, DB, Device, EndpointRecord, Integration, User } from "../domain";
import heroSignal from "../ml/edge/hero-signal.coreml.json";
import { bucketOf, modelSigningKey, newModelRecords, registryEntry } from "./ml";
import { analyzeText, analyzeUrl } from "../ml/analyzer";
import { id, newSigningKey, sha256, withSeededIds } from "./crypto";
import { freezeActor, preflight, reportOutcome, respond, tick, unfreezeActor } from "./gateway";
import { audit, STORE_VERSION } from "./store";

// ------------------------------------------------------------------ deterministic randomness
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Demo integration keys. Plaintext is only ever shown here and in the developer portal sandbox. */
export const DEMO_KEYS: Record<string, string> = {
  int_procurement: "orb_live_np_procure_5f8c2a91d7e4b603aa71",
  int_ap: "orb_live_np_apflows_0c4e9b3d17a2f88e6b10",
  int_support: "orb_live_np_support_9a1f6e2c8b4d0735e2d4",
  int_deploy: "orb_live_np_deploys_3b7d1a9e5c2f6084c9f1",
  int_access: "orb_live_np_access_b2e8c4f1a6d93075d3a2",
  int_data: "orb_live_np_datapipe_7e3a9c1b5d2f8046b7e9",
  int_sales: "orb_live_np_salesag_4d9b2e7a1c6f3058a1c3",
  int_health: "orb_live_np_records_8c2f5a9d3e1b7064f2b8",
  int_facility: "orb_live_np_facility_1a6e3c8b2d9f4075e8d6",
  int_ops: "orb_live_np_opsagent_6f1d8b3e9a2c5047c4a9",
  int_marketing: "orb_live_np_mktauto_2c8a5f1e7b3d9064d1e7",
  int_sandbox: "orb_test_np_sandbox_e5b1c9a3f7d2084b6c3e",
};
export const DEMO_USER_TOKEN_EMAIL = "alex.chen@northstar.cloud";

const ROUTES = ["security", "ai-governance", "finance-controller", "support-manager", "eng-oncall", "eng-manager", "data-owner", "sales-leader", "privacy", "facility-ops"];
const COLORS = ["#2747E8", "#0E7C66", "#B4560B", "#7A3FD1", "#C2185B", "#0B7285", "#5F6B7A", "#9C6B00", "#1F7A3D", "#A23B2C", "#3E5BA9", "#6D4C41"];

function users(tenant: string): User[] {
  const u = (key: string, name: string, title: string, roles: User["roles"], groups: string[], i: number): User => ({
    id: `usr_${key}`,
    tenant_id: tenant,
    name,
    email: `${key.replace("_", ".")}@northstar.cloud`,
    title,
    roles,
    groups,
    initials: name.split(" ").map((p) => p[0]).join(""),
    color: COLORS[i % COLORS.length],
    status: "active",
  });
  return [
    u("alex_chen", "Alex Chen", "Head of Platform Trust", ["owner", "admin", "policy_admin", "approver", "responder", "developer", "auditor"], [...ROUTES], 0),
    u("avery_kim", "Avery Kim", "Chief Information Security Officer", ["admin", "policy_admin", "approver", "responder", "auditor"], ["security", "ai-governance", "data-owner"], 1),
    u("jordan_patel", "Jordan Patel", "Corporate Controller", ["approver"], ["finance-controller"], 2),
    u("dana_whitfield", "Dana Whitfield", "Assistant Controller", ["approver"], ["finance-controller"], 3),
    u("sam_rivera", "Sam Rivera", "Director of Support", ["approver"], ["support-manager"], 4),
    u("riley_okafor", "Riley Okafor", "Engineering Manager, On-call", ["approver", "responder"], ["eng-oncall", "eng-manager"], 5),
    u("priya_raman", "Priya Raman", "VP Engineering", ["approver", "policy_admin"], ["eng-manager", "eng-oncall"], 6),
    u("morgan_lee", "Morgan Lee", "VP Sales", ["approver"], ["sales-leader"], 7),
    u("casey_nguyen", "Casey Nguyen", "Privacy Officer & Data Owner", ["approver", "auditor"], ["privacy", "data-owner"], 8),
    u("taylor_brooks", "Taylor Brooks", "DC-East Facility Manager", ["approver"], ["facility-ops"], 9),
    u("jamie_ortiz", "Jamie Ortiz", "Senior SRE", ["developer"], [], 10),
    u("quinn_harper", "Quinn Harper", "Compliance Analyst", ["auditor"], [], 11),
  ];
}

const integrationDefs: Array<Omit<Integration, "tenant_id" | "api_keys" | "created_at"> & { createdDaysAgo: number; webhook?: { url: string; status?: "active" | "failing" } }> = [
  { id: "int_procurement", name: "Procurement Agent", vendor: "LangGraph on AWS", kind: "agent_platform", description: "Autonomous sourcing agent that drafts RFP responses and vendor summaries.", mode: "enforce", status: "healthy", actor_ids: ["procurement-agent"], sdk: "Python SDK", createdDaysAgo: 120, webhook: { url: "https://agents.northstar.cloud/orbis/callback" } },
  { id: "int_ap", name: "AP Automation", vendor: "NetSuite workflow", kind: "workflow", description: "Accounts-payable workflow that schedules vendor payments.", mode: "enforce", status: "healthy", actor_ids: ["ap-workflow"], sdk: "TypeScript SDK", createdDaysAgo: 98, webhook: { url: "https://erp.northstar.cloud/hooks/orbis" } },
  { id: "int_support", name: "Support Copilot", vendor: "Zendesk AI", kind: "saas", description: "AI support agent that resolves tickets and issues refunds/credits.", mode: "enforce", status: "healthy", actor_ids: ["support-copilot"], sdk: "Webhook + REST", createdDaysAgo: 90, webhook: { url: "https://support.northstar.cloud/orbis/events" } },
  { id: "int_deploy", name: "Deploy Pipeline", vendor: "GitHub Actions", kind: "ci", description: "CI/CD automation gating production deploys.", mode: "enforce", status: "healthy", actor_ids: ["ci-deployer"], sdk: "TypeScript SDK", createdDaysAgo: 85, webhook: { url: "https://ci.northstar.cloud/orbis/webhook" } },
  { id: "int_access", name: "Access Broker", vendor: "Internal (Go)", kind: "internal", description: "Just-in-time privileged access requests for engineers.", mode: "enforce", status: "healthy", actor_ids: ["access-broker"], sdk: "REST", createdDaysAgo: 70 },
  { id: "int_data", name: "Data Pipeline", vendor: "Apache Airflow", kind: "workflow", description: "Scheduled data exports and warehouse syncs.", mode: "enforce", status: "healthy", actor_ids: ["export-workflow"], sdk: "Python SDK", createdDaysAgo: 64, webhook: { url: "https://data.northstar.cloud/airflow/orbis" } },
  { id: "int_sales", name: "Sales Agent", vendor: "Salesforce Agentforce", kind: "agent_platform", description: "AI SDR that drafts and sends prospect emails.", mode: "enforce", status: "healthy", actor_ids: ["sales-agent"], sdk: "REST", createdDaysAgo: 50 },
  { id: "int_health", name: "Partner Records Exchange", vendor: "Northstar Health Cloud", kind: "internal", description: "Regulated record releases to care partners under BAA.", mode: "enforce", status: "healthy", actor_ids: ["records-exchange"], sdk: "Python SDK", createdDaysAgo: 44 },
  { id: "int_facility", name: "Facility Ops AI", vendor: "DC telemetry (Python)", kind: "agent_platform", description: "Predictive maintenance agent for DC-East cooling.", mode: "enforce", status: "healthy", actor_ids: ["facility-ai"], sdk: "Python SDK", createdDaysAgo: 36 },
  { id: "int_ops", name: "Ops Agent", vendor: "Claude Agent SDK", kind: "agent_platform", description: "General AI operations agent and the growth outreach agent.", mode: "enforce", status: "degraded", actor_ids: ["ops-agent", "growth-agent"], sdk: "Agent Adapter (TS)", createdDaysAgo: 30, webhook: { url: "https://ops.northstar.cloud/hooks/orbis", status: "failing" } },
  { id: "int_marketing", name: "Marketing Automation", vendor: "HubSpot workflows", kind: "saas", description: "Observe-only pilot: scored, never blocked, before enforcement.", mode: "observe", status: "healthy", actor_ids: ["campaign-bot"], sdk: "Event stream", createdDaysAgo: 12 },
  { id: "int_sandbox", name: "Console Sandbox", vendor: "Orbis", kind: "sandbox", description: "Developer portal playground. Requests here never touch production systems.", mode: "enforce", status: "healthy", actor_ids: ["sandbox-agent"], sdk: "Console", createdDaysAgo: 120 },
];

const actorDefs: Array<Omit<Actor, "tenant_id" | "created_at">> = [
  { id: "procurement-agent", type: "agent", name: "Procurement Agent", description: "Summarizes vendor contracts and drafts RFP responses.", owner_team: "Finance Ops", integration_id: "int_procurement", trust: "trusted", baseline_per_hour: 3, tools: [{ tool: "llm.summarize", risk_class: "high" }, { tool: "docs.search", risk_class: "low" }, { tool: "email.send", risk_class: "high" }] },
  { id: "ap-workflow", type: "workflow", name: "AP Payment Run", description: "Schedules and releases vendor payments.", owner_team: "Finance", integration_id: "int_ap", trust: "trusted", baseline_per_hour: 2, tools: [{ tool: "payments.release", risk_class: "high" }] },
  { id: "support-copilot", type: "agent", name: "Support Copilot", description: "Resolves tickets; issues refunds and credits.", owner_team: "Support", integration_id: "int_support", trust: "trusted", baseline_per_hour: 4, tools: [{ tool: "billing.refund", risk_class: "medium" }, { tool: "tickets.reply", risk_class: "low" }, { tool: "crm.lookup", risk_class: "low" }] },
  { id: "ci-deployer", type: "automation", name: "CI Deployer", description: "Promotes builds through staging to production.", owner_team: "Platform Eng", integration_id: "int_deploy", trust: "trusted", baseline_per_hour: 2, tools: [{ tool: "deploy.promote", risk_class: "high" }] },
  { id: "access-broker", type: "service", name: "Access Broker", description: "Brokers just-in-time privileged access.", owner_team: "Security", integration_id: "int_access", trust: "trusted", baseline_per_hour: 1, tools: [{ tool: "iam.grant", risk_class: "high" }] },
  { id: "export-workflow", type: "workflow", name: "Warehouse Export", description: "Exports datasets to analytics sandboxes.", owner_team: "Data Platform", integration_id: "int_data", trust: "trusted", baseline_per_hour: 1, tools: [{ tool: "warehouse.export", risk_class: "high" }] },
  { id: "sales-agent", type: "agent", name: "Sales Agent", description: "AI SDR drafting outbound and follow-ups.", owner_team: "Revenue", integration_id: "int_sales", trust: "new", baseline_per_hour: 2, tools: [{ tool: "email.send", risk_class: "medium" }] },
  { id: "records-exchange", type: "workflow", name: "Records Exchange", description: "Releases regulated records to partners under BAA.", owner_team: "Health Cloud", integration_id: "int_health", trust: "trusted", baseline_per_hour: 1, tools: [{ tool: "hie.release", risk_class: "high" }] },
  { id: "facility-ai", type: "agent", name: "Facility Ops AI", description: "Predictive maintenance for DC-East chillers.", owner_team: "Infrastructure", integration_id: "int_facility", trust: "trusted", baseline_per_hour: 1, tools: [{ tool: "bms.stop_line", risk_class: "high" }, { tool: "telemetry.read", risk_class: "low" }] },
  { id: "ops-agent", type: "agent", name: "Ops Agent", description: "Triages alerts, rotates configs, runs runbooks.", owner_team: "SRE", integration_id: "int_ops", trust: "trusted", baseline_per_hour: 6, tools: [{ tool: "runbook.exec", risk_class: "medium" }, { tool: "config.write", risk_class: "medium" }, { tool: "db.delete", risk_class: "high" }] },
  { id: "growth-agent", type: "agent", name: "Growth Outreach Agent", description: "Autonomous outbound email to marketing leads.", owner_team: "Growth", integration_id: "int_ops", trust: "watch", baseline_per_hour: 3, tools: [{ tool: "email.bulk_send", risk_class: "high" }] },
  { id: "campaign-bot", type: "automation", name: "Campaign Bot", description: "Lifecycle email campaigns (observe-only pilot).", owner_team: "Marketing", integration_id: "int_marketing", trust: "new", baseline_per_hour: 2, tools: [{ tool: "email.campaign", risk_class: "medium" }] },
  { id: "sandbox-agent", type: "agent", name: "Sandbox Agent", description: "Requests sent from the developer portal sandbox.", owner_team: "Developers", integration_id: "int_sandbox", trust: "new", baseline_per_hour: 0, tools: [] },
];

// ------------------------------------------------------------------ envelope templates

type R = () => number;
const pick = <T,>(r: R, xs: T[]) => xs[Math.floor(r() * xs.length)];
const between = (r: R, a: number, b: number) => Math.round(a + r() * (b - a));
const VENDORS = ["acme-supplies.com", "globex-logistics.com", "initech-hardware.com"];
const NEW_VENDORS = ["brightline-fab.com", "orion-metalworks.com", "keystone-freight.io", "pacific-pallets.co"];
const EXT_MODELS = ["openwrite-ai.com", "summarizr.io", "quickgpt.app"];
const SERVICES = ["api-gateway", "billing-service", "auth-service", "search-indexer", "web-app", "notifications"];
const CUSTOMERS = ["Meridian Health Group", "Contoso Retail", "Fabrikam Inc", "Tailspin Toys", "Wide World Importers", "Litware", "Adatum Corp"];

type Template = (r: R, at: Date) => { integration: string; env: Omit<ActionEnvelope, "request_id"> };

const T: Record<string, { weight: number; make: Template }> = {
  procurement_internal: { weight: 7, make: (r) => ({ integration: "int_procurement", env: { actor: { type: "agent", id: "procurement-agent", owner: "finance" }, action: { type: "invoke_tool", tool: "docs.search", arguments_summary: "Search vendor master for renewal terms" }, resources: [{ type: "document", classification: "internal", count: between(r, 1, 8) }], intent: { reason: "Prepare renewal summary for category manager", source: "agent" } } }) },
  procurement_private_llm: { weight: 5, make: (r) => ({ integration: "int_procurement", env: { actor: { type: "agent", id: "procurement-agent", owner: "finance" }, action: { type: "external_send", tool: "llm.summarize", arguments_summary: `${between(r, 1, 6)} vendor contracts → summary` }, resources: [{ type: "document", classification: "confidential", count: between(r, 1, 6) }], destination: { type: "internal_model", value: "northstar-private-llm" }, intent: { reason: "Summarize vendor contracts for RFP response", source: "agent" } } }) },
  procurement_external_llm: { weight: 1.1, make: (r) => { const n = between(r, 2, 6); return { integration: "int_procurement", env: { actor: { type: "agent", id: "procurement-agent", owner: "finance" }, action: { type: "external_send", tool: "llm.summarize", title: `Send ${n} contracts to ${"external AI"}`, arguments_summary: `${n} confidential vendor contracts` }, resources: [{ type: "document", classification: "confidential", count: n }], destination: { type: "external_model", value: pick(r, EXT_MODELS) }, intent: { reason: "Summarize vendor contracts for RFP response", source: "agent" } } }; } },
  procurement_restricted: { weight: 0.25, make: (r) => ({ integration: "int_procurement", env: { actor: { type: "agent", id: "procurement-agent", owner: "finance" }, action: { type: "external_send", tool: "llm.summarize", title: "Send board pack to external AI", arguments_summary: "Restricted M&A board materials" }, resources: [{ type: "document", classification: "restricted", count: between(r, 1, 3) }], destination: { type: "external_model", value: pick(r, EXT_MODELS) }, intent: { reason: "Summarize board materials for exec brief", source: "agent" } } }) },
  ap_known: { weight: 5, make: (r) => ({ integration: "int_ap", env: { actor: { type: "workflow", id: "ap-workflow", owner: "finance" }, action: { type: "payment", tool: "payments.release", parameters: { amount_usd: 0 } }, resources: [{ type: "invoice", classification: "internal" }], destination: { type: "beneficiary", value: pick(r, VENDORS) }, business_context: { amount_usd: between(r, 400, 9_800) }, intent: { reason: "Scheduled net-30 vendor payment run", source: "workflow" } } }) },
  ap_new: { weight: 0.8, make: (r) => { const amt = between(r, 11_000, 96_000); return { integration: "int_ap", env: { actor: { type: "workflow", id: "ap-workflow", owner: "finance" }, action: { type: "payment", tool: "payments.release", parameters: { amount_usd: amt } }, resources: [{ type: "invoice", classification: "internal" }], destination: { type: "beneficiary", value: pick(r, NEW_VENDORS) }, business_context: { amount_usd: amt }, signals: { new_destination: true }, intent: { reason: "First invoice from newly onboarded supplier", source: "workflow" } } }; } },
  ap_huge: { weight: 0.12, make: (r) => { const amt = between(r, 260_000, 480_000); return { integration: "int_ap", env: { actor: { type: "workflow", id: "ap-workflow", owner: "finance" }, action: { type: "payment", tool: "payments.release", parameters: { amount_usd: amt } }, resources: [{ type: "invoice", classification: "internal" }], destination: { type: "beneficiary", value: pick(r, VENDORS) }, business_context: { amount_usd: amt }, intent: { reason: "Quarterly logistics prepayment", source: "workflow" } } }; } },
  refund_small: { weight: 9, make: (r) => ({ integration: "int_support", env: { actor: { type: "agent", id: "support-copilot", owner: "support" }, action: { type: "refund", tool: "billing.refund" }, resources: [{ type: "order", classification: "internal" }], destination: { type: "customer", value: pick(r, CUSTOMERS) }, business_context: { amount_usd: between(r, 20, 480), ticket: `ZD-${between(r, 50000, 56000)}` }, intent: { reason: "Duplicate charge reported by customer", source: "agent" } } }) },
  refund_mid: { weight: 3, make: (r) => ({ integration: "int_support", env: { actor: { type: "agent", id: "support-copilot", owner: "support" }, action: { type: "refund", tool: "billing.refund" }, resources: [{ type: "order", classification: "internal" }], destination: { type: "customer", value: pick(r, CUSTOMERS) }, business_context: { amount_usd: between(r, 520, 2_450), ticket: `ZD-${between(r, 50000, 56000)}` }, intent: { reason: "Pro-rated credit after plan downgrade", source: "agent" } } }) },
  refund_large: { weight: 0.9, make: (r) => { const amt = between(r, 2_700, 14_000); return { integration: "int_support", env: { actor: { type: "agent", id: "support-copilot", owner: "support" }, action: { type: "refund", tool: "billing.refund", parameters: { amount_usd: amt } }, resources: [{ type: "order", classification: "internal" }], destination: { type: "customer", value: pick(r, CUSTOMERS) }, business_context: { amount_usd: amt, ticket: `ZD-${between(r, 50000, 56000)}` }, intent: { reason: "SLA credit after service disruption", source: "agent" } } }; } },
  refund_absurd: { weight: 0.05, make: (r) => ({ integration: "int_support", env: { actor: { type: "agent", id: "support-copilot", owner: "support" }, action: { type: "refund", tool: "billing.refund" }, resources: [{ type: "order", classification: "internal" }], destination: { type: "customer", value: pick(r, CUSTOMERS) }, business_context: { amount_usd: between(r, 60_000, 120_000) }, intent: { reason: "full refund", source: "agent" } } }) },
  deploy_staging: { weight: 4, make: (r) => ({ integration: "int_deploy", env: { actor: { type: "automation", id: "ci-deployer", owner: "platform" }, action: { type: "deploy", tool: "deploy.promote" }, resources: [{ type: "service", id: pick(r, SERVICES), label: pick(r, SERVICES), environment: "staging" }], signals: { tests_passed: true }, intent: { reason: "Merge to main", source: "system" } } }) },
  deploy_prod_window: { weight: 3, make: (r) => ({ integration: "int_deploy", env: { actor: { type: "automation", id: "ci-deployer", owner: "platform" }, action: { type: "deploy", tool: "deploy.promote" }, resources: [{ type: "service", label: pick(r, SERVICES), environment: "production" }], signals: { tests_passed: true, outside_change_window: false }, business_context: { change_request: `CHG-${between(r, 1000, 1190)}` }, intent: { reason: "Scheduled release train", source: "system" } } }) },
  deploy_prod_outside: { weight: 0.6, make: (r) => ({ integration: "int_deploy", env: { actor: { type: "automation", id: "ci-deployer", owner: "platform" }, action: { type: "deploy", tool: "deploy.promote", parameters: { window_minutes: 30 } }, resources: [{ type: "service", label: pick(r, SERVICES), environment: "production" }], signals: { tests_passed: true, outside_change_window: true, incident_active: r() < 0.5 }, intent: { reason: "Hotfix for customer-impacting bug", source: "system" } } }) },
  deploy_failing: { weight: 0.25, make: (r) => ({ integration: "int_deploy", env: { actor: { type: "automation", id: "ci-deployer", owner: "platform" }, action: { type: "deploy", tool: "deploy.promote" }, resources: [{ type: "service", label: pick(r, SERVICES), environment: "production" }], signals: { tests_passed: false, outside_change_window: r() < 0.5 }, intent: { reason: "Release train", source: "system" } } }) },
  access_prod: { weight: 1.2, make: (r) => { const m = pick(r, [15, 30, 30, 45, 60]); return { integration: "int_access", env: { actor: { type: "human", id: pick(r, ["jamie.ortiz", "lee.sato", "ana.costa", "omar.haddad"]), owner: "engineering" }, action: { type: "grant_access", tool: "iam.grant", parameters: { duration_minutes: m } }, resources: [{ type: "database", label: pick(r, ["DB admin on prod-orders-db", "Admin on prod-billing-db", "Root on k8s prod cluster"]), environment: "production" }], business_context: { duration_minutes: m, ticket: `OPS-${between(r, 3000, 3320)}` }, intent: { reason: "Investigate production data inconsistency", source: "human" } } }; } },
  access_staging: { weight: 1.5, make: (r) => ({ integration: "int_access", env: { actor: { type: "human", id: pick(r, ["jamie.ortiz", "lee.sato", "ana.costa"]), owner: "engineering" }, action: { type: "grant_access", tool: "iam.grant" }, resources: [{ type: "database", label: "Admin on staging-db", environment: "staging" }], business_context: { duration_minutes: 60 }, intent: { reason: "Load test data reset", source: "human" } } }) },
  export_small: { weight: 2, make: (r) => ({ integration: "int_data", env: { actor: { type: "workflow", id: "export-workflow", owner: "data" }, action: { type: "data_export", tool: "warehouse.export" }, resources: [{ type: "table", classification: "internal" }], business_context: { record_count: between(r, 200, 8_000) }, intent: { reason: "Nightly product usage sync", source: "workflow" } } }) },
  export_bulk: { weight: 0.35, make: (r) => ({ integration: "int_data", env: { actor: { type: "workflow", id: "export-workflow", owner: "data" }, action: { type: "data_export", tool: "warehouse.export" }, resources: [{ type: "customer_table", classification: "confidential" }], business_context: { record_count: between(r, 15_000, 140_000), ...(r() < 0.4 ? { ticket: `SEC-${between(r, 4300, 4410)}` } : {}) }, intent: { reason: "Ad-hoc analysis request", source: "workflow" } } }) },
  sales_public: { weight: 3, make: (r) => ({ integration: "int_sales", env: { actor: { type: "agent", id: "sales-agent", owner: "revenue" }, action: { type: "email_send", tool: "email.send" }, resources: [{ type: "collateral", classification: "public" }], destination: { type: "external_domain", value: `${pick(r, ["contoso-retail", "fabrikam", "tailspin", "litware"])}.com` }, intent: { reason: "Follow-up after discovery call", source: "agent" } } }) },
  sales_pricing: { weight: 0.7, make: (r) => ({ integration: "int_sales", env: { actor: { type: "agent", id: "sales-agent", owner: "revenue" }, action: { type: "email_send", tool: "email.send" }, resources: [{ type: "pricing_sheet", classification: "confidential" }], destination: { type: "external_domain", value: `${pick(r, ["contoso-retail", "fabrikam", "tailspin", "litware"])}.com` }, business_context: { deal_id: `D-${between(r, 40, 99)}` }, intent: { reason: "Prospect asked for enterprise pricing", source: "agent" } } }) },
  records_release: { weight: 0.5, make: (r) => ({ integration: "int_health", env: { actor: { type: "workflow", id: "records-exchange", owner: "health-cloud" }, action: { type: "record_release", tool: "hie.release" }, resources: [{ type: "patient_record", classification: "regulated" }], destination: { type: "partner", value: "carelink-hie.org" }, business_context: { record_count: between(r, 400, 30_000) }, intent: { reason: "Care coordination sync under BAA", source: "workflow" } } }) },
  facility_read: { weight: 3, make: () => ({ integration: "int_facility", env: { actor: { type: "agent", id: "facility-ai", owner: "infra" }, action: { type: "invoke_tool", tool: "telemetry.read" }, resources: [{ type: "sensor", classification: "internal" }], intent: { reason: "Hourly vibration trend analysis", source: "agent" } } }) },
  facility_stop: { weight: 0.12, make: (r) => ({ integration: "int_facility", env: { actor: { type: "agent", id: "facility-ai", owner: "infra" }, action: { type: "operational_stop", tool: "bms.stop_line" }, resources: [{ type: "equipment", label: pick(r, ["chiller line 1", "chiller line 3", "CRAH unit 7"]), classification: "internal" }], intent: { reason: "Bearing temperature trending above threshold", source: "agent" } } }) },
  ops_runbook: { weight: 8, make: (r) => ({ integration: "int_ops", env: { actor: { type: "agent", id: "ops-agent", owner: "sre" }, action: { type: "invoke_tool", tool: pick(r, ["runbook.exec", "logs.query", "pager.ack"]) }, resources: [{ type: "runbook", classification: "internal" }], intent: { reason: "Auto-remediate disk pressure alert", source: "agent" } } }) },
  ops_config: { weight: 2, make: () => ({ integration: "int_ops", env: { actor: { type: "agent", id: "ops-agent", owner: "sre" }, action: { type: "config_change", tool: "config.write" }, resources: [{ type: "config", environment: "staging", classification: "internal" }], intent: { reason: "Raise connection pool size after saturation alert", source: "agent" } } }) },
  ops_delete: { weight: 0.15, make: () => ({ integration: "int_ops", env: { actor: { type: "agent", id: "ops-agent", owner: "sre" }, action: { type: "delete", tool: "db.delete" }, resources: [{ type: "table", environment: "production", classification: "internal" }], intent: { reason: "cleanup", source: "agent" } } }) },
  growth_send: { weight: 3, make: (r) => ({ integration: "int_ops", env: { actor: { type: "agent", id: "growth-agent", owner: "growth" }, action: { type: "email_send", tool: "email.bulk_send" }, resources: [{ type: "lead_list", classification: "internal", count: between(r, 50, 400) }], destination: { type: "external_domain", value: "leads.various" }, intent: { reason: "Nurture sequence step 3", source: "agent" } } }) },
  campaign: { weight: 2.5, make: (r) => ({ integration: "int_marketing", env: { actor: { type: "automation", id: "campaign-bot", owner: "marketing" }, action: { type: "email_send", tool: "email.campaign" }, resources: [{ type: "campaign", classification: r() < 0.2 ? "confidential" : "public" }], destination: { type: "external_domain", value: "customers.various" }, intent: { reason: "Monthly product newsletter", source: "workflow" } } }) },
};

// ------------------------------------------------------------------ build

export function buildSeed(now = new Date()): DB {
  return withSeededIds(`northstar:${now.toISOString()}`, () => buildSeedInner(now));
}

function buildSeedInner(now: Date): DB {
  const r = mulberry32(20261004);
  const tenantId = "ten_northstar";
  const policyBase = new Date(now.getTime() - 95 * 86_400_000);
  const policies: Policy[] = buildDefaultPolicies(policyBase);
  const finalPointer = Object.fromEntries(policies.map((p) => [p.id, p.current_version]));

  const db: DB = {
    version: STORE_VERSION,
    seeded_at: now.toISOString(),
    signing_key: newSigningKey(`orbis-np-${now.toISOString().slice(0, 7)}`),
    tenant: {
      id: tenantId,
      name: "Northstar Cloud",
      slug: "northstar",
      region: "us-east-1",
      plan: "Business",
      retention_days: 365,
      created_at: new Date(now.getTime() - 130 * 86_400_000).toISOString(),
      settings: {
        timezone: "America/New_York",
        business_hours: { start: 8, end: 19 },
        policy_publish_requires_second_approver: true,
        metadata_only_mode: false,
        sso: { provider: "Okta (OIDC)", enabled: true, domain: "northstar.cloud" },
        scim: false,
        notification_policy: "minimal_summary",
        data_region: "United States (us-east-1)",
      },
      usage: { decisions_this_month: 0, included_decisions: 250_000 },
    },
    users: users(tenantId),
    devices: [],
    integrations: [],
    actors: [],
    policies,
    actions: [],
    approvals: [],
    receipts: [],
    webhooks: [],
    deliveries: [],
    freezes: [],
    audit: [],
    protect: [],
    sessions: [],
    approved_destinations: [...APPROVED_DESTINATIONS],
    known_destinations: [...APPROVED_DESTINATIONS, "contoso-retail.com", "fabrikam.com"],
    ml: {
      fusion: { ...DEFAULT_FUSION_POLICY },
      kill_switch: false,
      models: newModelRecords(now),
      manifest_seq: 11,
      signing_key: modelSigningKey(),
      endpoints: [],
      activations: [],
      baselines: {},
      predictions: [],
      feedback: [],
    },
  };
  seedEndpoints(db, now, r);

  const iphoneModels = ["iPhone 17 Pro", "iPhone 16", "iPhone 17", "iPhone 15 Pro", "iPhone Air"];
  db.devices = db.users
    .filter((u) => u.roles.includes("approver"))
    .map<Device>((u, i) => ({
      id: `dev_${u.id.slice(4)}`,
      user_id: u.id,
      name: `${u.name.split(" ")[0]}'s iPhone`,
      model: iphoneModels[i % iphoneModels.length],
      os: i % 3 === 0 ? "iOS 26.5" : "iOS 26.4",
      registered_at: new Date(now.getTime() - (60 - i * 3) * 86_400_000).toISOString(),
      last_seen_at: new Date(now.getTime() - between(r, 2, 600) * 60_000).toISOString(),
      trust: i === 0 || i === 1 ? "managed" : "registered",
      push: true,
      biometric: "face_id",
    }));
  db.devices.push({ id: "dev_lost_jordan", user_id: "usr_jordan_patel", name: "Jordan's old iPhone", model: "iPhone 14", os: "iOS 18.6", registered_at: new Date(now.getTime() - 200 * 86_400_000).toISOString(), last_seen_at: new Date(now.getTime() - 40 * 86_400_000).toISOString(), trust: "revoked", push: false, biometric: "face_id" });

  for (const d of integrationDefs) {
    const created = new Date(now.getTime() - d.createdDaysAgo * 86_400_000).toISOString();
    const plaintext = DEMO_KEYS[d.id];
    const { createdDaysAgo: _c, webhook, ...rest } = d;
    void _c;
    const integration: Integration = {
      ...rest,
      tenant_id: tenantId,
      created_at: created,
      first_protected_at: new Date(new Date(created).getTime() + between(r, 6, 38) * 60_000).toISOString(),
      api_keys: [
        { id: id("key"), label: d.kind === "sandbox" ? "Sandbox key" : "Production key", prefix: plaintext.slice(0, 16), hash: sha256(plaintext), environment: d.kind === "sandbox" ? "sandbox" : "production", scopes: ["decisions:write", "approvals:write", "outcomes:write", "receipts:read"], created_at: created },
      ],
    };
    if (d.id === "int_ap") {
      integration.api_keys.unshift({ id: id("key"), label: "Rotated 2026-08", prefix: "orb_live_np_apfl", hash: sha256("rotated-old"), environment: "production", scopes: ["decisions:write"], created_at: new Date(now.getTime() - 98 * 86_400_000).toISOString(), revoked_at: new Date(now.getTime() - 41 * 86_400_000).toISOString() });
    }
    if (webhook) {
      const wid = id("whk");
      db.webhooks.push({ id: wid, integration_id: d.id, url: webhook.url, secret_hint: `whsec_…${sha256(d.id).slice(0, 4)}`, events: ["decision.final", "approval.resolved"], status: webhook.status ?? "active", created_at: created });
      integration.webhook_id = wid;
    }
    db.integrations.push(integration);
  }
  db.actors = actorDefs.map((a) => ({ ...a, tenant_id: tenantId, created_at: db.integrations.find((i) => i.id === a.integration_id)!.created_at }));
  const integ = (iid: string) => db.integrations.find((i) => i.id === iid)!;
  const user = (uid: string) => db.users.find((u) => u.id === uid)!;
  const sys = { kind: "system" as const, id: "orbis", name: "Orbis" };

  // ---------------- scheduled operations, executed in time order so the audit chain is chronological
  type Op = { t: number; seq: number; run: () => void };
  const heap: Op[] = [];
  let seq = 0;
  const less = (a: Op, b: Op) => a.t < b.t || (a.t === b.t && a.seq < b.seq);
  const at = (ms: number, run: () => void) => {
    if (ms > now.getTime()) return; // never schedule into the future
    heap.push({ t: ms, seq: seq++, run });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const popMin = (): Op | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (rr < heap.length && less(heap[rr], heap[m])) m = rr;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  at(new Date(db.tenant.created_at).getTime(), () => audit(db, { at: db.tenant.created_at, type: "tenant.created", actor: sys, summary: "Tenant Northstar Cloud provisioned in us-east-1 (Business plan)" }));
  for (const u of db.users) at(new Date(db.tenant.created_at).getTime() + 3_600_000, () => audit(db, { at: new Date(new Date(db.tenant.created_at).getTime() + 3_600_000).toISOString(), type: "user.provisioned", actor: { kind: "system", id: "okta", name: "Okta SSO" }, target: { type: "user", id: u.id }, summary: `${u.name} provisioned via SSO (${u.roles.join(", ")})` }));
  for (const i of db.integrations) for (const k of i.api_keys) {
    at(new Date(k.created_at).getTime() + 1, () => audit(db, { at: k.created_at, type: "api_key.created", actor: { kind: "user", id: "usr_alex_chen", name: "Alex Chen" }, target: { type: "integration", id: i.id }, summary: `API key ${k.prefix}… created for ${i.name}` }));
    if (k.revoked_at) at(new Date(k.revoked_at).getTime(), () => audit(db, { at: k.revoked_at!, type: "api_key.revoked", actor: { kind: "user", id: "usr_alex_chen", name: "Alex Chen" }, target: { type: "integration", id: i.id }, summary: `API key ${k.prefix}… revoked after scheduled rotation` }));
  }
  for (const d of db.devices) at(new Date(d.registered_at).getTime(), () => audit(db, { at: d.registered_at, type: "device.registered", actor: { kind: "user", id: d.user_id, name: user(d.user_id).name }, target: { type: "device", id: d.id }, summary: `${d.name} (${d.model}) registered${d.trust === "managed" ? " · MDM managed" : ""}` }));
  const revokedAt = new Date(now.getTime() - 40 * 86_400_000);
  at(revokedAt.getTime(), () => audit(db, { at: revokedAt.toISOString(), type: "device.revoked", actor: { kind: "user", id: "usr_avery_kim", name: "Avery Kim" }, target: { type: "device", id: "dev_lost_jordan" }, summary: "Jordan's old iPhone revoked (reported lost) — step-up from this device is rejected" }));

  // Policy history: apply version pointers as of each moment so historical decisions used the policy live at the time.
  const publishTimes: Array<{ t: number; pid: string; v: number; by: string; note: string }> = [];
  for (const p of policies) for (const v of p.versions) if (v.published_at) publishTimes.push({ t: new Date(v.published_at).getTime(), pid: p.id, v: v.version, by: v.created_by, note: v.change_note });
  for (const p of policies) p.current_version = Math.min(...p.versions.filter((v) => v.published_at).map((v) => v.version));
  for (const pt of publishTimes) {
    at(pt.t, () => {
      const p = policies.find((x) => x.id === pt.pid)!;
      p.current_version = pt.v;
      const author = db.users.find((u) => u.email.startsWith(pt.by)) ?? user("usr_alex_chen");
      audit(db, { at: new Date(pt.t).toISOString(), type: "policy.published", actor: { kind: "user", id: author.id, name: author.name }, target: { type: "policy", id: pt.pid }, summary: `${p.name} v${pt.v} published — ${pt.note}`, data: { second_approver: author.id === "usr_avery_kim" ? "Alex Chen" : "Avery Kim" } });
    });
  }
  for (const p of policies) for (const v of p.versions.filter((x) => x.status === "draft")) at(new Date(v.created_at).getTime(), () => audit(db, { at: v.created_at, type: "policy.draft_saved", actor: { kind: "user", id: "usr_alex_chen", name: "Alex Chen" }, target: { type: "policy", id: p.id }, summary: `${p.name} v${v.version} draft saved — awaiting simulation & second approver` }));

  // Freeze history
  const growthFreezeAt = now.getTime() - 2 * 86_400_000 - 3 * 3_600_000;
  const supportFreezeAt = now.getTime() - 12 * 86_400_000 - 5 * 3_600_000;
  at(supportFreezeAt, () => freezeActor(db, "support-copilot", user("usr_alex_chen"), "Copilot issued 9 duplicate credits in 4 minutes after prompt update v3.8.1", "ios", { at: new Date(supportFreezeAt), silent: true }));
  at(supportFreezeAt + 42 * 60_000, () => unfreezeActor(db, "support-copilot", user("usr_alex_chen"), "Prompt regression rolled back (v3.8.2); duplicate credits reversed", { at: new Date(supportFreezeAt + 42 * 60_000), silent: true }));
  at(growthFreezeAt, () => freezeActor(db, "growth-agent", user("usr_avery_kim"), "Outbound volume 14× baseline; sending to an unverified purchased lead list", "ios", { at: new Date(growthFreezeAt), silent: true }));

  // ---------------- history: 28 days of protected actions
  const approvalPlans = new Map<string, { outcome: string }>();
  const DAYS = 28;
  const entries = Object.entries(T);
  const totalW = entries.reduce((s, [, v]) => s + v.weight, 0);
  for (let d = DAYS; d >= 0; d--) {
    const dayStart = new Date(now.getTime() - d * 86_400_000);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dow = dayStart.getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const volume = Math.round((weekend ? 18 : 52) * (0.85 + r() * 0.3));
    for (let k = 0; k < volume; k++) {
      // Business-hour skew (ET ≈ UTC−4).
      const hour = weekend ? between(r, 0, 23) : Math.min(23, Math.max(0, Math.round(16 + (r() + r() + r() - 1.5) * 6)));
      const t = dayStart.getTime() + hour * 3_600_000 + between(r, 0, 3_599) * 1000;
      if (t > now.getTime() - 60 * 60_000) continue;
      let x = r() * totalW;
      let name = entries[0][0];
      for (const [n, v] of entries) {
        x -= v.weight;
        if (x <= 0) {
          name = n;
          break;
        }
      }
      if (name === "growth_send" && t > growthFreezeAt + 6 * 3_600_000 && r() < 0.6) continue;
      if (name === "campaign" && t < now.getTime() - 12 * 86_400_000) continue;
      const tpl = T[name].make(r, new Date(t));
      // Spike: growth agent behaves anomalously in the hours before the freeze.
      const anomaly = (tpl.env.actor.id === "growth-agent" && t > growthFreezeAt - 8 * 3_600_000 && t < growthFreezeAt) || (tpl.env.actor.id === "ops-agent" && r() < 0.03);
      const env: ActionEnvelope = { ...tpl.env, request_id: `req_${Math.floor(r() * 1e12).toString(36)}${k}`, signals: { ...(tpl.env.signals ?? {}), ...(anomaly ? { actor_anomaly: true } : {}) }, ttl_seconds: 1800 };
      if (env.action.parameters && "amount_usd" in env.action.parameters) env.action.parameters = { ...env.action.parameters, amount_usd: Number(env.business_context?.amount_usd ?? 0) };
      const roll = r();
      at(t, () => {
        const res = preflight(db, integ(tpl.integration), env, { at: new Date(t), silent: true });
        const action = res.action;
        if (res.approval) {
          const ap = res.approval;
          const plan = roll < 0.06 ? "expire" : roll < 0.2 ? "reject" : roll < 0.32 && ap.safe_alternatives.length ? "alt" : roll < 0.4 && ap.editable_fields.length ? "edit" : "approve";
          approvalPlans.set(ap.id, { outcome: plan });
          const latency = Math.round(Math.exp(Math.log(70) + (r() - 0.5) * 2.4) * 1000) + (r() < 0.1 ? between(r, 300, 1200) * 1000 : 0);
          if (plan === "expire") {
            at(new Date(ap.expires_at).getTime() + 1000, () => tick(db, new Date(new Date(ap.expires_at).getTime() + 1000), { silent: true }));
          } else {
            const pool = db.users.filter((u) => u.groups.includes(ap.route) && u.id !== "usr_alex_chen");
            const responders = (pool.length ? pool : [user("usr_alex_chen")]).slice();
            const need = plan === "reject" ? 1 : (ap.quorum?.required ?? 1);
            for (let q = 0; q < need; q++) {
              const who = responders.length > q ? responders[(q + Math.floor(r() * responders.length)) % responders.length] : user("usr_alex_chen");
              const rt = t + latency * (q + 1);
              const device = db.devices.find((dv) => dv.user_id === who.id && dv.trust !== "revoked");
              const channel = device && r() < 0.86 ? "ios" : "web";
              const useAlt = plan === "alt" && q === need - 1;
              const useEdit = plan === "edit" && q === need - 1;
              const field = ap.editable_fields[0];
              at(rt, () => {
                if (ap.status !== "pending" || ap.responses.some((x) => x.user_id === who.id)) return;
                const cur = Number(ap.parameters[field?.key ?? ""] ?? field?.max ?? 30);
                try {
                  respond(
                    db,
                    ap.id,
                    who,
                    {
                      decision: plan === "reject" ? "reject" : useAlt ? "safe_alternative" : useEdit ? "approve_modified" : "approve",
                      alternative_id: useAlt ? ap.safe_alternatives[0].id : undefined,
                      modified_parameters: useEdit && field ? { [field.key]: Math.max(field.min ?? 0, Math.round(cur * 0.6)) } : undefined,
                      step_up: { method: channel === "ios" ? "biometric" : "passkey", verified: true, device_id: channel === "ios" ? device?.id : undefined },
                      channel,
                      comment: plan === "reject" ? pick(r, ["Not without a signed MSA.", "Use the approved vendor instead.", "Scope too broad — resubmit with a ticket.", "Wait for the change window."]) : undefined,
                      unnecessary: plan === "approve" && ap.risk.level === "medium" && r() < 0.35,
                    },
                    { at: new Date(rt), silent: true },
                  );
                } catch {
                  /* stale schedule; ignore */
                }
              });
            }
          }
        }
        // Outcome reporting by the caller.
        const ot = t + between(r, 3, 90) * 1000 + (res.approval ? 30 * 60_000 : 0);
        at(ot, () => {
          if (action.final_status === "pending" || action.outcome || ot > now.getTime()) return;
          const ok = ["allow", "warn", "approved", "approved_modified"].includes(action.final_status);
          if (!ok && r() > 0.7) return;
          try {
            reportOutcome(db, action.id, integ(action.integration_id), ok ? (r() < 0.965 ? "succeeded" : "failed") : "not_executed", ok ? undefined : "Caller honored decision", { at: new Date(ot), silent: true });
          } catch {
            /* ignore */
          }
        });
      });
    }
  }

  // The anomaly that triggered the growth-agent freeze: ~14x its baseline in the 5 hours before.
  for (let k = 0; k < 64; k++) {
    const t = growthFreezeAt - Math.round(r() * 5 * 3_600_000) - 60_000;
    const tpl = T.growth_send.make(r, new Date(t));
    const env: ActionEnvelope = { ...tpl.env, request_id: `req_burst_${k}_${Math.floor(r() * 1e9).toString(36)}`, signals: { actor_anomaly: true }, ttl_seconds: 1800 };
    at(t, () => {
      const res = preflight(db, integ(tpl.integration), env, { at: new Date(t), silent: true });
      at(t + 4000, () => {
        if (!res.action.outcome && res.action.final_status !== "pending") reportOutcome(db, res.action.id, integ(res.action.integration_id), "succeeded", undefined, { at: new Date(t + 4000), silent: true });
      });
    });
  }
  // A few blocked attempts after the freeze.
  for (let k = 0; k < 9; k++) {
    const t = growthFreezeAt + (k + 1) * 3 * 3_600_000 + Math.round(r() * 3_600_000);
    const tpl = T.growth_send.make(r, new Date(t));
    at(t, () => void preflight(db, integ(tpl.integration), { ...tpl.env, request_id: `req_frozen_${k}`, ttl_seconds: 1800 }, { at: new Date(t), silent: true }));
  }

  // Demo B — behavioural drift: the support copilot's restricted CRM pulls double every day for a week.
  // Deterministic policy has no rule for read-only lookups; the behavioural signals are what notice it.
  for (let d = 0; d < 7; d++) {
    for (let k = 0; k < 4; k++) {
      const day0 = Math.floor((now.getTime() - (7 - d) * 86_400_000) / 86_400_000) * 86_400_000;
      const t = day0 + (14 + k * 2) * 3_600_000 + Math.round(r() * 1_800_000); // 10:00-16:30 New York
      if (t > now.getTime() - 3_600_000) continue;
      const count = 20 * 2 ** d;
      const env: ActionEnvelope = {
        request_id: `req_ramp_${d}_${k}`,
        actor: { type: "agent", id: "support-copilot", owner: "support" },
        action: { type: "invoke_tool", tool: "crm.lookup", title: `Look up ${count.toLocaleString("en-US")} customer records`, arguments_summary: `CRM lookup across ${count.toLocaleString("en-US")} accounts for "billing dispute triage"` },
        resources: [{ type: "customer_record", classification: "restricted", count }],
        intent: { reason: "Billing dispute triage", source: "agent" },
        ttl_seconds: 3600,
      };
      at(t, () => {
        const res = preflight(db, integ("int_support"), env, { at: new Date(t), silent: true });
        at(t + 5000, () => {
          if (!res.action.outcome && res.action.final_status !== "pending" && t + 5000 < now.getTime()) reportOutcome(db, res.action.id, integ("int_support"), ["allow", "warn"].includes(res.action.final_status) ? "succeeded" : "not_executed", undefined, { at: new Date(t + 5000), silent: true });
        });
      });
    }
  }

  // Yesterday's hero run: the procurement host's endpoint agent scored it locally (Swift + Core ML,
  // recorded from `orbis-endpoint replay fixtures/endpoint-events/hero.jsonl`); completed with Safe Redirect.
  const heroT = now.getTime() - 26 * 3_600_000;
  at(heroT, () => {
    const res = preflight(db, integ("int_procurement"), heroEnvelope(`req_hero_${heroT.toString(36)}`, "summarizr.io"), { at: new Date(heroT), silent: true, endpointSignal: { endpoint_id: heroSignal.endpoint_id, signal: heroSignal } });
    if (!res.approval) return;
    respond(db, res.approval.id, user("usr_avery_kim"), { decision: "safe_alternative", alternative_id: "redirect_internal_model", step_up: { method: "biometric", verified: true, device_id: "dev_avery_kim" }, channel: "ios" }, { at: new Date(heroT + 48_000), silent: true });
    reportOutcome(db, res.action.id, integ("int_procurement"), "succeeded", "Summary generated on northstar-private-llm", { at: new Date(heroT + 61_000), silent: true });
  });

  seedPendingApprovals(db, now, at);

  // Ops scheduled during execution (responses/outcomes) always land later in time, so a heap keeps order.
  for (let op = popMin(); op; op = popMin()) op.run();
  for (const p of policies) p.current_version = finalPointer[p.id];

  seedProtect(db, now);
  tick(db, now, { silent: true });
  db.tenant.usage.decisions_this_month = db.actions.filter((a) => new Date(a.received_at).getUTCMonth() === now.getUTCMonth()).length + 41_200;
  return db;
}

export function heroEnvelope(requestId: string, destination = "quickscribe-ai.app"): ActionEnvelope {
  return {
    request_id: requestId,
    actor: { type: "agent", id: "procurement-agent", owner: "finance", display_name: "Procurement Agent" },
    action: {
      type: "external_send",
      tool: "llm.summarize",
      title: "Send 4 contracts to external AI",
      arguments_summary: "4 confidential vendor contracts (MSA + 3 SOWs) for summarization",
      parameters: { destination, documents: 4, model: "gpt-class external" },
    },
    resources: [{ type: "document", classification: "confidential", count: 4, label: "Vendor contracts — Brightline, Orion, Keystone, Acme" }],
    destination: { type: "external_model", value: destination },
    intent: { reason: "Summarize four vendor contracts for the Q4 RFP response", source: "agent" },
    business_context: { deal_id: "D-82" },
    evidence: [
      { id: "ev_1", label: "Documents", value: "MSA-Brightline.pdf, SOW-Orion-v3.pdf, SOW-Keystone.pdf, Acme-Renewal-2027.pdf", source: "Procurement Agent", freshness: "now", confidence: "high", kind: "fact" },
      { id: "ev_2", label: "Data class", value: "Confidential — pricing, liability caps, termination terms", source: "DLP classifier (customer)", freshness: "now", confidence: "high", kind: "signal" },
      { id: "ev_3", label: "Destination", value: `${destination} — not on AI provider allowlist, 30-day retention, unknown training policy`, source: "Orbis destination registry", freshness: "today", confidence: "high", kind: "fact" },
      { id: "ev_4", label: "Agent history", value: "212 tool calls in 14 days · 0 prior external sends", source: "Orbis baseline", freshness: "live", confidence: "medium", kind: "history" },
    ],
    blast_radius: ["4 confidential contracts leave Northstar's trust boundary", "Vendor pricing and liability terms exposed to a third-party provider", "Deal D-82 ($1.8M) negotiating position at risk"],
    ttl_seconds: 900,
  };
}

function seedPendingApprovals(db: DB, now: Date, schedule: (ms: number, run: () => void) => void) {
  const integ = (iid: string) => db.integrations.find((i) => i.id === iid)!;
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const ev = (label: string, value: string, source: string, kind: "fact" | "signal" | "history" | "diff" | "link" = "fact", confidence: "high" | "medium" | "low" = "high", freshness = "live") => ({ id: `ev_${label.toLowerCase().replace(/\W+/g, "_")}`, label, value, source, kind, confidence, freshness });

  const make = (iid: string, minAgo: number, env: Omit<ActionEnvelope, "request_id">, ttlMin: number) =>
    preflight(db, integ(iid), { ...env, request_id: `req_live_${iid}_${minAgo}`, ttl_seconds: ttlMin * 60 }, { at: ago(minAgo), silent: true });
  // Scheduled on the shared timeline so the audit chain stays chronological.
  const q = (min: number, run: () => void) => schedule(now.getTime() - min * 60_000, run);
  const results: Record<string, ReturnType<typeof make>> = {};

  q(7, () => make("int_ap", 7, {
    actor: { type: "workflow", id: "ap-workflow", owner: "finance" },
    action: { type: "payment", tool: "payments.release", title: "Pay new vendor $84,000", arguments_summary: "Release INV-20931 to Brightline Fabrication LLC via ACH", parameters: { amount_usd: 84_000, beneficiary: "Brightline Fabrication LLC", invoice: "INV-20931" } },
    resources: [{ type: "invoice", id: "INV-20931", classification: "internal" }],
    destination: { type: "beneficiary", value: "brightline-fab.com" },
    business_context: { amount_usd: 84_000 },
    signals: { new_destination: true, fraud_signal: true },
    intent: { reason: "Net-15 payment for fabricated rack enclosures (PO-7781)", source: "workflow" },
    evidence: [
      ev("Invoice", "INV-20931 · $84,000.00 · net 15 · matches PO-7781 (3-way match ✓)", "NetSuite"),
      ev("Vendor age", "Created 2 days ago by ap.clerk@northstar.cloud", "Vendor master", "history"),
      ev("Bank change", "Beneficiary account changed 19 hours ago (Chase → Mercury)", "NetSuite audit log", "signal", "high"),
      ev("Payment history", "0 prior payments to this beneficiary", "Orbis history", "history"),
      ev("Fraud signal", "Bank change + first payment pattern matches 3 BEC cases this quarter", "Customer fraud model", "signal", "medium"),
    ],
    blast_radius: ["$84,000 leaves the operating account", "ACH is irreversible after the 17:00 ET cutoff", "Vendor becomes 'known' for future auto-approval under $10k"],
  }, 600));

  q(18, () => make("int_support", 18, {
    actor: { type: "agent", id: "support-copilot", owner: "support" },
    action: { type: "refund", tool: "billing.refund", title: "Refund $8,500", arguments_summary: "Refund Meridian Health Group for the INC-2281 outage", parameters: { amount_usd: 8_500, customer: "Meridian Health Group" } },
    resources: [{ type: "invoice", id: "INV-MHG-0925", classification: "internal" }],
    destination: { type: "customer", value: "Meridian Health Group" },
    business_context: { amount_usd: 8_500, ticket: "ZD-55120", incident_id: "INC-2281" },
    intent: { reason: "SLA credit after 3h 12m API outage affecting this customer", source: "agent" },
    evidence: [
      ev("Contract", "$102,000 ARR · SLA credit 8% of monthly fee per breach hour → entitled $8,160", "Salesforce"),
      ev("Incident", "INC-2281 · SEV-1 · 3h 12m · 1,240 failed requests for this tenant", "PagerDuty", "link"),
      ev("Customer health", "At risk · renewal in 41 days · exec escalation open", "Gainsight", "signal", "medium"),
      ev("Copilot reasoning", "Rounded up to $8,500 as goodwill gesture", "Support Copilot", "fact", "medium"),
    ],
    blast_radius: ["$8,500 card refund to Meridian Health Group", "Sets a precedent above contractual SLA ($8,160)"],
  }, 480));

  q(3, () => make("int_deploy", 3, {
    actor: { type: "automation", id: "ci-deployer", owner: "platform" },
    action: { type: "deploy", tool: "deploy.promote", title: "Deploy api-gateway v2.41.0 to Production", arguments_summary: "Hotfix: connection pool exhaustion under retry storm", parameters: { version: "v2.41.0", window_minutes: 20 } },
    resources: [{ type: "service", id: "api-gateway", label: "api-gateway v2.41.0", environment: "production" }],
    business_context: { incident_id: "INC-2291", change_request: "CHG-1187" },
    signals: { outside_change_window: true, incident_active: true, tests_passed: true, rollback_ready: true },
    intent: { reason: "Mitigate INC-2291 (SEV-2): 502s from pool exhaustion", source: "system" },
    evidence: [
      ev("Diff", "3 commits · +48 −12 · pool.ts, retry.ts, config/prod.yaml (max_conns 200→400)", "GitHub", "diff"),
      ev("Tests", "1,284 passed · 0 failed · coverage 87.2%", "GitHub Actions"),
      ev("Incident", "INC-2291 · SEV-2 · 502 rate 4.1% · started 38 min ago", "PagerDuty", "link"),
      ev("Rollback", "Blue/green · automated rollback in ~90s · last rollback drill 6 days ago", "Argo Rollouts"),
      ev("Canary", "5% canary for 10 min, auto-abort on error rate > 1%", "Argo Rollouts"),
    ],
    blast_radius: ["All public API traffic (~42k requests/min)", "3 dependent services restart connections", "Change window opens for 20 minutes"],
  }, 120));

  q(26, () => make("int_access", 26, {
    actor: { type: "human", id: "jamie.ortiz", owner: "engineering", display_name: "Jamie Ortiz (SRE)" },
    action: { type: "grant_access", tool: "iam.grant", title: "Grant DB Admin for 30 min", arguments_summary: "Admin role on prod-orders-db for Jamie Ortiz", parameters: { duration_minutes: 30, role: "db_admin" } },
    resources: [{ type: "database", id: "prod-orders-db", label: "DB admin on prod-orders-db", environment: "production" }],
    business_context: { duration_minutes: 30, ticket: "OPS-3310" },
    intent: { reason: "Repair 214 orphaned order rows after failed migration 0187", source: "human" },
    evidence: [
      ev("Ticket", "OPS-3310 · P2 · assigned to Jamie Ortiz", "Jira", "link"),
      ev("On-call", "Jamie is primary on-call this week", "PagerDuty", "signal"),
      ev("Last grant", "12 days ago · 20 min · closed cleanly", "Orbis history", "history"),
      ev("Session", "Recorded via Teleport; queries logged", "Teleport"),
    ],
    blast_radius: ["Write access to 38M order rows for 30 minutes", "Auto-revoked at expiry; session recorded"],
  }, 240));

  q(120, () => (results.export = make("int_data", 120, {
    actor: { type: "workflow", id: "export-workflow", owner: "data" },
    action: { type: "data_export", tool: "warehouse.export", title: "Export 120,000 customer records", arguments_summary: "customers_v3 → analytics-sandbox (S3 us-east-1)", parameters: { records: 120_000, destination: "analytics-sandbox" } },
    resources: [{ type: "customer_table", id: "customers_v3", classification: "confidential" }],
    business_context: { record_count: 120_000, ticket: "SEC-4411" },
    intent: { reason: "Retrain churn model with Q3 cohort", source: "workflow" },
    evidence: [
      ev("Fields", "name, email, plan, MRR, last_login — no payment or support text", "Warehouse schema"),
      ev("Exception ticket", "SEC-4411 approved scope: churn modeling, 30-day retention", "Jira", "link"),
      ev("Destination", "analytics-sandbox · private S3 · KMS-encrypted · auto-delete 30d", "AWS"),
    ],
    blast_radius: ["120,000 customer identities copied outside the warehouse", "Sandbox accessible to 9 data scientists"],
  }, 480)));
  q(95, () => results.export?.approval && respond(db, results.export.approval.id, db.users.find((u) => u.id === "usr_casey_nguyen")!, { decision: "approve", step_up: { method: "biometric", verified: true, device_id: "dev_casey_nguyen" }, channel: "ios", comment: "Scope matches SEC-4411. Needs security sign-off." }, { at: ago(95), silent: true }));

  q(41, () => make("int_sales", 41, {
    actor: { type: "agent", id: "sales-agent", owner: "revenue" },
    action: { type: "email_send", tool: "email.send", title: "Email non-public pricing to Contoso", arguments_summary: "Enterprise Pricing FY27 (Confidential).pdf to buyer@contoso-retail.com", parameters: { recipient: "buyer@contoso-retail.com", attachment: "Enterprise Pricing FY27" } },
    resources: [{ type: "pricing_sheet", classification: "confidential" }],
    destination: { type: "external_domain", value: "contoso-retail.com" },
    business_context: { deal_id: "D-82" },
    intent: { reason: "Prospect requested enterprise pricing after demo", source: "agent" },
    evidence: [
      ev("Deal", "D-82 · $1.8M · Negotiation · close date in 23 days", "Salesforce"),
      ev("Attachment", "Includes discount schedule (up to 38%) and partner margins", "DLP classifier", "signal"),
      ev("Recipient", "First contact 9 days ago · procurement role · NDA not on file", "Salesforce", "history", "medium"),
    ],
    blast_radius: ["Partner margin and discount floor visible to a prospect", "Could anchor negotiation for 4 open deals with Contoso's partners"],
  }, 360));

  q(420, () => make("int_health", 420, {
    actor: { type: "workflow", id: "records-exchange", owner: "health-cloud" },
    action: { type: "record_release", tool: "hie.release", title: "Release 18,400 patient records", arguments_summary: "Quarterly care-coordination sync to CareLink HIE", parameters: { record_limit: 18_400 } },
    resources: [{ type: "patient_record", classification: "regulated", count: 18_400 }],
    destination: { type: "partner", value: "carelink-hie.org" },
    business_context: { record_count: 18_400 },
    intent: { reason: "Quarterly care coordination under BAA-2024-117", source: "workflow" },
    evidence: [
      ev("BAA", "BAA-2024-117 on file · expires 2027-03-31", "Contracts"),
      ev("Scope", "6 fields: MRN, name, DOB, PCP, last visit, care program", "Exchange config"),
      ev("Prior release", "90 days ago · 17,950 records · no incidents", "Orbis history", "history"),
    ],
    blast_radius: ["18,400 regulated records leave Northstar", "Disclosure logged for HIPAA accounting"],
  }, 720));

  q(12, () => make("int_facility", 12, {
    actor: { type: "agent", id: "facility-ai", owner: "infra" },
    action: { type: "operational_stop", tool: "bms.stop_line", title: "Stop chiller line 2 in DC-East", arguments_summary: "Controlled shutdown of chiller line 2 for bearing inspection", parameters: { line: "chiller-2", mode: "full_stop" } },
    resources: [{ type: "equipment", id: "chiller-2", label: "chiller line 2", classification: "internal" }],
    intent: { reason: "Bearing vibration and temperature trending toward failure", source: "agent" },
    evidence: [
      ev("Vibration", "11.2 mm/s RMS (alarm 7.1) · rising 0.8 mm/s per hour", "BMS sensors", "signal"),
      ev("Bearing temp", "84 °C · +3 °C/h", "BMS sensors", "signal"),
      ev("Prediction", "Failure window 6–18 h", "Facility Ops AI", "signal", "medium"),
      ev("Redundancy", "Line 3 at 71% capacity · N+1 holds if load shifted", "BMS"),
    ],
    blast_radius: ["DC-East cooling capacity −33% until restart", "Requires shifting ~1.2 MW of workloads to DC-West"],
  }, 180));

  q(54, () => (results.quorum = make("int_ap", 54, {
    actor: { type: "workflow", id: "ap-workflow", owner: "finance" },
    action: { type: "payment", tool: "payments.release", title: "Pay Globex Logistics $310,000", arguments_summary: "Q4 freight prepayment", parameters: { amount_usd: 310_000, beneficiary: "Globex Logistics" } },
    resources: [{ type: "invoice", id: "INV-GX-4471", classification: "internal" }],
    destination: { type: "beneficiary", value: "globex-logistics.com" },
    business_context: { amount_usd: 310_000 },
    intent: { reason: "Q4 freight capacity prepayment per contract amendment 3", source: "workflow" },
    evidence: [
      ev("Vendor", "Globex Logistics · verified vendor since 2023 · 41 prior payments", "Vendor master", "history"),
      ev("Contract", "Amendment 3 signed 2026-09-12 · prepay clause", "Ironclad", "link"),
    ],
    blast_radius: ["$310,000 leaves the operating account", "Q4 freight capacity reserved"],
  }, 600)));
  q(31, () => results.quorum?.approval && respond(db, results.quorum.approval.id, db.users.find((u) => u.id === "usr_jordan_patel")!, { decision: "approve", step_up: { method: "biometric", verified: true, device_id: "dev_jordan_patel" }, channel: "ios" }, { at: ago(31), silent: true }));
}

/**
 * Demo endpoint fleet (portfolio mode simulates the fleet, blueprint §17.3). Health numbers are scaled
 * from the measured Apple M4 Pro benchmark. Real `orbis-endpoint` processes register alongside as real=true.
 */
function seedEndpoints(db: DB, now: Date, r: () => number) {
  const bench = registryEntry("1.0.0")?.benchmark;
  const p95 = (bench?.warm_us.p95 ?? 57) / 1000;
  const pipe = (bench?.pipeline_us.p95 ?? 63) / 1000;
  const mem = bench?.memory_mb.peak_footprint ?? 21;
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const mk = (id: string, name: string, kind: EndpointRecord["kind"], owner: string, extra: Partial<EndpointRecord> = {}): EndpointRecord => {
    const f = 0.85 + r() * 0.6;
    return {
      id, name, kind, owner, os: kind === "developer_mac" ? "macOS 26.6" : "macOS 26.6 (server)", app_version: "2.0.0", bucket: bucketOf(id),
      model_version: "1.0.0", feature_schema: "edge-features/1", last_update_at: ago(15 * 24 - Math.round(r() * 20)), last_seen_at: ago(r() * 0.2), signature: "verified", state: "healthy",
      health: { inference_p95_ms: +(p95 * f).toFixed(4), pipeline_p95_ms: +(pipe * f * 1.1).toFixed(4), memory_mb: +(mem * (0.95 + r() * 0.15)).toFixed(1), cpu_percent: +(0.4 + r() * 2.2).toFixed(2), queue_depth: Math.round(r() * 3), failures_24h: 0, fallbacks_24h: 0 },
      telemetry: { events_24h: Math.round(200 + r() * 4000), high_priority_24h: Math.round(r() * 40), dropped_24h: 0 }, real: false, ...extra,
    };
  };
  const hosts: Array<[string, string, string]> = [
    ["ep_procurement-agent_host", "procurement-agent host (Mac mini M4)", "int_procurement"],
    ["ep_support-copilot_host", "support-copilot host (Mac mini M4)", "int_support"],
    ["ep_ops-agent_host", "ops-agent host (Mac Studio)", "int_ops"],
    ["ep_sales-agent_host", "sales-agent host (Mac mini M4)", "int_sales"],
    ["ep_facility-ai_host", "facility-ai host (Mac mini M2)", "int_facility"],
    ["ep_ap-workflow_host", "AP workflow host (Mac mini M4)", "int_ap"],
    ["ep_export-workflow_host", "warehouse export host (Mac mini M4)", "int_data"],
  ];
  const eps: EndpointRecord[] = hosts.map(([id, name, iid]) => mk(id, name, "agent_host", db.integrations.find((i) => i.id === iid)?.name ?? iid, { integration_id: iid }));
  for (const u of db.users) eps.push(mk(`ep_mbp_${u.id.slice(4)}`, `${u.name.split(" ")[0]}'s MacBook Pro`, "developer_mac", u.name));
  for (let k = 1; k <= 4; k++) eps.push(mk(`ep_ci_runner_${k}`, `CI runner ${k} (macOS)`, "ci_runner", "Platform Eng"));
  const set = (id: string, patch: Partial<EndpointRecord>) => Object.assign(eps.find((e) => e.id === id)!, patch);
  set("ep_mbp_taylor_brooks", { model_version: "0.9.0", last_seen_at: ago(4 * 24 + 3), last_update_at: ago(41 * 24), state: "stale", note: "Offline 4 days — still on 0.9.0 (old but valid signature); updates on next check-in." });
  set("ep_mbp_quinn_harper", { model_version: "0.9.0", last_seen_at: ago(3 * 24 + 7), last_update_at: ago(40 * 24), state: "stale", note: "Offline 3 days — 0.9.0 manifest expires in 4 days." });
  set("ep_ci_runner_4", { app_version: "1.4.2", feature_schema: "edge-features/0", model_version: null, state: "incompatible", note: "App 1.4.2 only supports edge-features/0 — model refused, endpoint runs deterministic fallback until upgraded.", health: { inference_p95_ms: 0, pipeline_p95_ms: 0.012, memory_mb: 9.8, cpu_percent: 0.2, queue_depth: 0, failures_24h: 0, fallbacks_24h: 1312 } });
  set("ep_facility-ai_host", { state: "degraded", note: "Older M2 host under thermal pressure — p95 above fleet median, still within the 20 ms budget.", health: { inference_p95_ms: +(p95 * 3.1).toFixed(4), pipeline_p95_ms: +(pipe * 3.4).toFixed(4), memory_mb: 23.4, cpu_percent: 6.8, queue_depth: 14, failures_24h: 0, fallbacks_24h: 0 } });
  db.ml.endpoints = eps;
  db.ml.activations = [
    { endpoint_id: "ep_ci_runner_2", version: "1.0.0", activated: false, error: "signature verification failed — manifest payload modified in transit (MITM drill); previous model kept", at: ago(6 * 24 + 5) },
    { endpoint_id: "ep_ci_runner_2", version: "1.0.0", activated: true, at: ago(6 * 24 + 4), compile_ms: 27.1 },
    ...eps.filter((e) => e.model_version === "1.0.0").slice(0, 12).map((e, i) => ({ endpoint_id: e.id, version: "1.0.0", activated: true, at: ago(15 * 24 - i), compile_ms: +(24 + r() * 8).toFixed(1) })),
  ];
}

function seedProtect(db: DB, now: Date) {
  const allow = db.approved_destinations;
  const items: Array<{ user: string; kind: "url" | "text" | "qr" | "screenshot"; input: string; min: number }> = [
    { user: "usr_jordan_patel", kind: "text", input: "Hi Jordan, it's Priya. I'm in a board meeting and can't talk. I need 6 Apple gift cards ($500 each) for a client today — keep this between us, send codes by text.", min: 95 },
    { user: "usr_sam_rivera", kind: "url", input: "https://northstar-payroll-update.com/login?session=8812", min: 240 },
    { user: "usr_alex_chen", kind: "qr", input: "https://bit.ly/ns-parking-pay", min: 600 },
    { user: "usr_morgan_lee", kind: "url", input: "https://docs.google.com/presentation/d/1x-contoso-qbr", min: 1300 },
    { user: "usr_taylor_brooks", kind: "screenshot", input: "Your Northstar SSO password expires today. Verify now at https://northstar-sso-reset.com/login to keep access.", min: 2100 },
    { user: "usr_dana_whitfield", kind: "text", input: "Vendor update from Brightline: we changed our bank details, please wire the March invoice to the new account below ASAP.", min: 2900 },
    { user: "usr_riley_okafor", kind: "url", input: "https://github.com/northstar-cloud/api-gateway/pull/1187", min: 3500 },
    { user: "usr_avery_kim", kind: "url", input: "http://microsoft365-login.weeblysite.com/office/verify", min: 4800 },
    { user: "usr_casey_nguyen", kind: "text", input: "Reminder: privacy review for the CareLink renewal moved to Thursday 2pm.", min: 6000 },
    { user: "usr_priya_raman", kind: "qr", input: "https://sso.northstar.cloud/device", min: 7200 },
  ];
  for (const it of items) {
    const res = it.kind === "url" || it.kind === "qr" ? analyzeUrl(it.input, allow) : analyzeText(it.input, allow);
    const t = new Date(now.getTime() - it.min * 60_000).toISOString();
    const a = { id: id("pa"), tenant_id: db.tenant.id, user_id: it.user, kind: it.kind, input_preview: it.input.slice(0, 160), verdict: res.verdict, score: res.score, recommendation: res.recommendation, reasons: res.reasons, model: res.model, policy_note: res.policy_note, created_at: t, channel: "ios" as const };
    db.protect.push(a);
  }
  db.protect.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export type { ApprovalRecord };
