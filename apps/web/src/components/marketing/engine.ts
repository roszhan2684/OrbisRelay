// The real Orbis policy engine, running in the browser for the marketing demos.
import { APPROVED_DESTINATIONS, DEFAULT_POLICIES, evaluate, publishedVersion, type ActionEnvelope } from "@orbis/policy-core";

const live = DEFAULT_POLICIES.map((p) => ({ policy: p, version: publishedVersion(p)! }));
const known = new Set([...APPROVED_DESTINATIONS, "contoso-retail.com"]);

export function runEngine(env: ActionEnvelope, frozen: string[] = []) {
  const t = performance.now();
  const e = evaluate(env, live, {
    now: new Date("2026-10-06T15:00:00Z"),
    frozenActors: new Set(frozen),
    approvedDestinations: new Set(APPROVED_DESTINATIONS),
    knownDestinations: known,
  });
  return { ...e, micros: Math.max(1, Math.round((performance.now() - t) * 1000)) };
}

export const STREAM: Array<{ title: string; actor: string; kind: "agent" | "workflow" | "automation" | "human"; env: Omit<ActionEnvelope, "request_id"> }> = [
  { title: "Search vendor master", actor: "Procurement Agent", kind: "agent", env: { actor: { type: "agent", id: "procurement-agent" }, action: { type: "invoke_tool", tool: "docs.search" }, resources: [{ type: "document", classification: "internal" }], intent: { reason: "Prepare renewal summary" } } },
  { title: "Refund $120", actor: "Support Copilot", kind: "agent", env: { actor: { type: "agent", id: "support-copilot" }, action: { type: "refund" }, resources: [{ type: "order" }], business_context: { amount_usd: 120 }, intent: { reason: "Duplicate charge reported" } } },
  { title: "Send 4 contracts to quickscribe-ai.app", actor: "Procurement Agent", kind: "agent", env: { actor: { type: "agent", id: "procurement-agent" }, action: { type: "external_send", tool: "llm.summarize" }, resources: [{ type: "document", classification: "confidential", count: 4 }], destination: { type: "external_model", value: "quickscribe-ai.app" }, intent: { reason: "Summarize contracts for RFP" } } },
  { title: "Deploy web-app to staging", actor: "CI Deployer", kind: "automation", env: { actor: { type: "automation", id: "ci-deployer" }, action: { type: "deploy" }, resources: [{ type: "service", environment: "staging" }], signals: { tests_passed: true }, intent: { reason: "Merge to main" } } },
  { title: "Pay Acme Supplies $4,200", actor: "AP Payment Run", kind: "workflow", env: { actor: { type: "workflow", id: "ap-workflow" }, action: { type: "payment" }, resources: [{ type: "invoice" }], destination: { type: "beneficiary", value: "acme-supplies.com" }, business_context: { amount_usd: 4200 }, intent: { reason: "Scheduled net-30 run" } } },
  { title: "Refund $900", actor: "Support Copilot", kind: "agent", env: { actor: { type: "agent", id: "support-copilot" }, action: { type: "refund" }, resources: [{ type: "order" }], business_context: { amount_usd: 900 }, intent: { reason: "Pro-rated downgrade credit" } } },
  { title: "Export 120,000 customer records", actor: "Warehouse Export", kind: "workflow", env: { actor: { type: "workflow", id: "export-workflow" }, action: { type: "data_export" }, resources: [{ type: "customer_table", classification: "confidential" }], business_context: { record_count: 120000 }, intent: { reason: "ad hoc" } } },
  { title: "Summarize on private LLM", actor: "Procurement Agent", kind: "agent", env: { actor: { type: "agent", id: "procurement-agent" }, action: { type: "external_send", tool: "llm.summarize" }, resources: [{ type: "document", classification: "confidential", count: 3 }], destination: { type: "internal_model", value: "northstar-private-llm" }, intent: { reason: "Summarize contracts for RFP" } } },
  { title: "Pay new vendor $84,000", actor: "AP Payment Run", kind: "workflow", env: { actor: { type: "workflow", id: "ap-workflow" }, action: { type: "payment" }, resources: [{ type: "invoice" }], destination: { type: "beneficiary", value: "brightline-fab.com" }, business_context: { amount_usd: 84000 }, signals: { fraud_signal: true }, intent: { reason: "First invoice from new supplier" } } },
  { title: "Delete orders table (prod)", actor: "Ops Agent", kind: "agent", env: { actor: { type: "agent", id: "ops-agent" }, action: { type: "delete" }, resources: [{ type: "table", environment: "production" }], intent: { reason: "cleanup" } } },
  { title: "Grant DB admin · 30 min", actor: "Jamie Ortiz", kind: "human", env: { actor: { type: "human", id: "jamie.ortiz" }, action: { type: "grant_access" }, resources: [{ type: "database", environment: "production" }], business_context: { duration_minutes: 30, ticket: "OPS-3310" }, intent: { reason: "Repair orphaned order rows" } } },
  { title: "Run disk-pressure runbook", actor: "Ops Agent", kind: "agent", env: { actor: { type: "agent", id: "ops-agent" }, action: { type: "invoke_tool", tool: "runbook.exec" }, resources: [{ type: "runbook", classification: "internal" }], intent: { reason: "Auto-remediate alert" } } },
  { title: "Deploy api-gateway to prod (off-window)", actor: "CI Deployer", kind: "automation", env: { actor: { type: "automation", id: "ci-deployer" }, action: { type: "deploy" }, resources: [{ type: "service", environment: "production" }], signals: { tests_passed: true, outside_change_window: true, incident_active: true }, intent: { reason: "Hotfix for INC-2291" } } },
  { title: "Email public one-pager", actor: "Sales Agent", kind: "agent", env: { actor: { type: "agent", id: "sales-agent" }, action: { type: "email_send" }, resources: [{ type: "collateral", classification: "public" }], destination: { type: "external_domain", value: "contoso-retail.com" }, intent: { reason: "Follow-up after call" } } },
];
