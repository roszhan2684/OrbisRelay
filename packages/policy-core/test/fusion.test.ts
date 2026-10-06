import { describe, expect, it } from "vitest";
import { combineSignals, DEFAULT_FUSION_POLICY, fuse, type MlSignal } from "../src/fusion";

const sig = (over: Partial<MlSignal> = {}): MlSignal => ({
  source: "cloud",
  model_version: "1.0.0",
  feature_schema: "edge-features/1",
  class: "safe_normal",
  risk: 0.01,
  abstain: false,
  ood: false,
  high_impact: true,
  reasons: [],
  ...over,
});
const det = (status: "allow" | "warn" | "deny" | "approval_required", frozen = false) => ({
  status,
  effect: (status === "allow" ? "allow" : status === "warn" ? "warn" : status === "deny" ? "deny" : "require_approval") as "allow",
  frozen,
});
const up = { available: true };

describe("policy + ML fusion (blueprint §25)", () => {
  it("hard deny wins regardless of the model", () => {
    expect(fuse(det("deny"), sig({ class: "safe_normal" }), up)).toMatchObject({ status: "deny", rule: "hard_deny_wins", changed: false });
    expect(fuse(det("allow", true), sig({ class: "high_risk" }), up).rule).toBe("hard_deny_wins");
  });

  it("a deterministic approval requirement is never lowered by a 'safe' model", () => {
    expect(fuse(det("approval_required"), sig({ class: "safe_normal", risk: 0 }), up)).toMatchObject({ status: "approval_required", rule: "deterministic_approval_wins" });
  });

  it("deterministic allow + high model risk escalates to approval on the security route", () => {
    const r = fuse(det("allow"), sig({ class: "high_risk", risk: 0.97 }), up);
    expect(r).toMatchObject({ status: "approval_required", effect: "require_approval", rule: "model_escalated_to_approval", changed: true, route: "security" });
  });

  it("suspicious raises allow to warn but never lowers", () => {
    expect(fuse(det("allow"), sig({ class: "suspicious_review", risk: 0.6 }), up)).toMatchObject({ status: "warn", rule: "model_raised_to_warn" });
    expect(fuse(det("warn"), sig({ class: "suspicious_review" }), up)).toMatchObject({ status: "warn", rule: "deterministic_stands", changed: false });
    expect(fuse(det("warn"), sig({ class: "safe_normal" }), up)).toMatchObject({ status: "warn", changed: false });
  });

  it("unavailable, stale or incompatible models degrade to deterministic policy", () => {
    for (const reason of ["model_unavailable", "stale_model", "incompatible_schema", "kill_switch"] as const) {
      expect(fuse(det("allow"), sig({ class: "high_risk" }), { available: false, reason })).toMatchObject({ status: "allow", rule: "model_unavailable_fallback" });
    }
    expect(fuse(det("allow"), null, { available: true }).rule).toBe("model_unavailable_fallback");
  });

  it("abstained high-impact actions go to a human; low-impact ones do not", () => {
    expect(fuse(det("allow"), sig({ abstain: true, ood: true, high_impact: true }), up)).toMatchObject({ status: "approval_required", rule: "abstain_high_impact_escalated" });
    expect(fuse(det("allow"), sig({ abstain: true, ood: true, high_impact: false }), up)).toMatchObject({ status: "allow", changed: false });
  });

  it("advisory and off modes never change the outcome", () => {
    expect(fuse(det("allow"), sig({ class: "high_risk" }), up, { ...DEFAULT_FUSION_POLICY, mode: "advisory" })).toMatchObject({ status: "allow", rule: "advisory_only" });
    expect(fuse(det("allow"), sig({ class: "high_risk" }), up, { ...DEFAULT_FUSION_POLICY, mode: "off" })).toMatchObject({ status: "allow", rule: "fusion_off" });
  });

  it("a compromised endpoint cannot launder risk: the more severe of local and cloud wins", () => {
    const local = sig({ source: "local", class: "safe_normal", risk: 0.0 });
    const cloud = sig({ source: "cloud", class: "high_risk", risk: 0.99 });
    expect(combineSignals(local, cloud)).toMatchObject({ class: "high_risk", source: "local+cloud" });
    expect(combineSignals(null, cloud)?.source).toBe("cloud");
  });
});
