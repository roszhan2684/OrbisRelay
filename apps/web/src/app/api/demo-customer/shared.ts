import "server-only";
import { OrbisClient } from "@orbis/sdk";
import { DEMO_KEYS, heroEnvelope } from "@/lib/server/seed";

// The Northstar demo "customer backend". It holds its own API keys server-side and talks to the
// Orbis gateway over HTTP through the public SDK — exactly like a real integration would.
export function client(req: Request, integration: keyof typeof DEMO_KEYS) {
  const origin = new URL(req.url).origin;
  return new OrbisClient({ apiKey: DEMO_KEYS[integration], baseUrl: origin });
}

export const SCENARIOS = {
  hero: { integration: "int_procurement" as const, build: (id: string) => heroEnvelope(id) },
  refund: {
    integration: "int_support" as const,
    build: (id: string) => ({
      request_id: id,
      actor: { type: "agent" as const, id: "support-copilot" },
      action: { type: "refund" as const, tool: "billing.refund", title: "Refund $8,500", arguments_summary: "SLA credit for Tailspin Toys after INC-2302", parameters: { amount_usd: 8500, customer: "Tailspin Toys" } },
      resources: [{ type: "order", classification: "internal" as const }],
      destination: { type: "customer" as const, value: "Tailspin Toys" },
      business_context: { amount_usd: 8500, ticket: "ZD-55410", incident_id: "INC-2302" },
      intent: { reason: "SLA credit after a 2h 40m outage affecting this customer", source: "agent" as const },
      evidence: [
        { id: "e1", label: "Contract", value: "$96,000 ARR · SLA credit entitles $7,680", source: "Salesforce", kind: "fact" as const, confidence: "high" as const },
        { id: "e2", label: "Incident", value: "INC-2302 · SEV-1 · 2h 40m", source: "PagerDuty", kind: "link" as const, confidence: "high" as const },
      ],
      blast_radius: ["$8,500 card refund", "Exceeds contractual SLA credit by $820"],
      ttl_seconds: 1800,
    }),
  },
  deploy: {
    integration: "int_deploy" as const,
    build: (id: string) => ({
      request_id: id,
      actor: { type: "automation" as const, id: "ci-deployer" },
      action: { type: "deploy" as const, tool: "deploy.promote", title: "Deploy billing-service v3.12.1 to Production", arguments_summary: "Hotfix: invoice rounding regression", parameters: { version: "v3.12.1", window_minutes: 20 } },
      resources: [{ type: "service", id: "billing-service", label: "billing-service v3.12.1", environment: "production" as const }],
      business_context: { incident_id: "INC-2304", change_request: "CHG-1191" },
      signals: { outside_change_window: true, incident_active: true, tests_passed: true, rollback_ready: true },
      intent: { reason: "Fix invoice rounding regression during INC-2304", source: "system" as const },
      evidence: [
        { id: "e1", label: "Diff", value: "2 commits · +31 −9 · rounding.ts", source: "GitHub", kind: "diff" as const, confidence: "high" as const },
        { id: "e2", label: "Tests", value: "912 passed · 0 failed", source: "GitHub Actions", kind: "fact" as const, confidence: "high" as const },
        { id: "e3", label: "Rollback", value: "Blue/green · ~90s automated rollback", source: "Argo Rollouts", kind: "fact" as const, confidence: "high" as const },
      ],
      blast_radius: ["All invoice generation (~3k invoices/hour)", "20-minute change window opens"],
      ttl_seconds: 1800,
    }),
  },
  ops: {
    integration: "int_ops" as const,
    build: (id: string) => ({
      request_id: id,
      actor: { type: "agent" as const, id: "ops-agent" },
      action: { type: "config_change" as const, tool: "config.write", title: "Rotate connection pool config", arguments_summary: "staging pool size 200 → 260" },
      resources: [{ type: "config", environment: "staging" as const, classification: "internal" as const }],
      intent: { reason: "Pool saturation alert on staging", source: "agent" as const },
      signals: { actor_anomaly: true },
    }),
  },
};
export type ScenarioKey = keyof typeof SCENARIOS;
