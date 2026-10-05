import { describe, expect, it } from "vitest";
import { APPROVED_DESTINATIONS, DEFAULT_POLICIES, evaluate, publishedVersion, simulate, type ActionEnvelope, type EvaluationContext } from "../src";

const live = DEFAULT_POLICIES.map((p) => ({ policy: p, version: publishedVersion(p)! }));
const ctx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({
  now: new Date("2026-10-06T15:00:00Z"), // Tuesday, business hours
  frozenActors: new Set(),
  approvedDestinations: new Set(APPROVED_DESTINATIONS),
  ...over,
});

const hero: ActionEnvelope = {
  request_id: "req_hero",
  actor: { type: "agent", id: "procurement-agent", owner: "finance" },
  action: { type: "external_send", tool: "llm.summarize", title: "Send 4 contracts to external AI" },
  resources: [{ type: "document", classification: "confidential", count: 4 }],
  destination: { type: "external_model", value: "openwrite-ai.com" },
  intent: { reason: "Summarize vendor contracts for RFP response", source: "agent" },
};

describe("golden decisions", () => {
  it("hero: confidential → unapproved AI pauses for biometric approval with safe redirect", () => {
    const e = evaluate(hero, live, ctx());
    expect(e.status).toBe("approval_required");
    expect(e.deciding?.policy_id).toBe("pol_conf_external");
    expect(e.approval?.step_up).toBe("biometric");
    expect(e.safe_alternatives.map((s) => s.id)).toContain("redirect_internal_model");
    expect(e.risk.reasons.map((r) => r.code)).toContain("sensitive_external");
  });

  it("same task on the approved internal model is allowed", () => {
    const e = evaluate({ ...hero, destination: { type: "internal_model", value: "northstar-private-llm" } }, live, ctx());
    expect(e.status).toBe("allow");
  });

  it("frozen actor is always denied regardless of policy", () => {
    const e = evaluate({ ...hero, destination: { type: "internal_model", value: "northstar-private-llm" } }, live, ctx({ frozenActors: new Set(["procurement-agent"]) }));
    expect(e.status).toBe("deny");
    expect(e.frozen).toBe(true);
    expect(e.effect).toBe("freeze");
  });

  it("refunds: warn → approval → hard deny as amount grows", () => {
    const refund = (amount: number): ActionEnvelope => ({
      request_id: "r",
      actor: { type: "agent", id: "support-copilot" },
      action: { type: "refund" },
      resources: [{ type: "order" }],
      business_context: { amount_usd: amount, ticket: "ZD-1" },
      intent: { reason: "Outage credit for affected customer" },
    });
    expect(evaluate(refund(120), live, ctx()).status).toBe("allow");
    expect(evaluate(refund(900), live, ctx()).status).toBe("warn");
    expect(evaluate(refund(8_500), live, ctx()).status).toBe("approval_required");
    expect(evaluate(refund(80_000), live, ctx()).status).toBe("deny");
  });

  it("payments: quorum above $250k", () => {
    const e = evaluate(
      {
        request_id: "p",
        actor: { type: "workflow", id: "ap-workflow" },
        action: { type: "payment" },
        resources: [{ type: "invoice" }],
        destination: { type: "beneficiary", value: "acme-supplies.com" },
        business_context: { amount_usd: 310_000 },
      },
      live,
      ctx(),
    );
    expect(e.effect).toBe("require_quorum");
    expect(e.approval?.quorum).toEqual({ required: 2, of: 3 });
  });

  it("bulk export blocked without ticket, quorum with ticket", () => {
    const base: ActionEnvelope = {
      request_id: "x",
      actor: { type: "workflow", id: "export-workflow" },
      action: { type: "data_export" },
      resources: [{ type: "customer_table", classification: "confidential" }],
      business_context: { record_count: 120_000 },
    };
    expect(evaluate(base, live, ctx()).status).toBe("deny");
    const withTicket = evaluate({ ...base, business_context: { record_count: 120_000, ticket: "SEC-4411" } }, live, ctx());
    expect(withTicket.effect).toBe("require_quorum");
  });

  it("production deploy: failing tests beat the change window path", () => {
    const deploy = (signals: ActionEnvelope["signals"]): ActionEnvelope => ({
      request_id: "d",
      actor: { type: "automation", id: "ci-deployer" },
      action: { type: "deploy" },
      resources: [{ type: "service", environment: "production" }],
      signals,
    });
    expect(evaluate(deploy({ outside_change_window: true, tests_passed: true }), live, ctx()).status).toBe("approval_required");
    expect(evaluate(deploy({ outside_change_window: true, tests_passed: false }), live, ctx()).status).toBe("deny");
    expect(evaluate(deploy({ outside_change_window: false, tests_passed: true }), live, ctx()).status).toBe("allow");
  });

  it("is deterministic", () => {
    const a = evaluate(hero, live, ctx());
    const b = evaluate(hero, live, ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("simulator", () => {
  it("draft v18 changes restricted egress to deny", () => {
    const draft = DEFAULT_POLICIES.map((p) => ({ policy: p, version: p.id === "pol_conf_external" ? p.versions.find((v) => v.version === 18)! : publishedVersion(p)! }));
    const restricted: ActionEnvelope = { ...hero, resources: [{ type: "document", classification: "restricted", count: 1 }] };
    const r = simulate([{ id: "a1", envelope: restricted, at: new Date() }], live, draft, () => ctx());
    expect(r.changed).toBe(1);
    expect(r.rows[0].candidate.status).toBe("deny");
  });
});
