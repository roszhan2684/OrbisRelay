import { describe, expect, it } from "vitest";
import { buildSeed } from "../seed";
import { applyOp, type Op } from "../ops";
import { roleVersions, signedManifest } from "../ml";
import { verifyAuditChain } from "../store";
import { createPublicKey, verify } from "node:crypto";

const run = (db: ReturnType<typeof buildSeed>, op: Op, n: number) => applyOp(db, { id: `op_test_${n}`, at: new Date(Date.UTC(2026, 9, 4, 18, n)).toISOString(), op });
const admin = "usr_alex_chen";

describe("model control plane (ops are deterministic and replayable)", () => {
  it("blocks deployment of a model whose release gates fail", () => {
    const db = buildSeed(new Date("2026-10-04T18:00:00Z"));
    expect(() => run(db, { kind: "ml_promote", version: "1.1.0", to: "shadow", user_id: admin, reason: "try" }, 1)).toThrow(/release gate/);
  });

  it("rollback → canary → latency breach auto-rolls back → re-promote", () => {
    const db = buildSeed(new Date("2026-10-04T18:00:00Z"));
    const seq0 = db.ml.manifest_seq;
    run(db, { kind: "ml_rollback", version: "1.0.0", user_id: admin, reason: "drill" }, 1);
    expect(roleVersions(db, Date.UTC(2026, 9, 4, 19)).production).toBe("0.9.0");
    run(db, { kind: "ml_promote", version: "1.0.0", to: "shadow", user_id: admin, reason: "" }, 2);
    run(db, { kind: "ml_promote", version: "1.0.0", to: "canary", percent: 25, user_id: admin, reason: "" }, 3);
    const t = Date.UTC(2026, 9, 4, 19);
    expect(roleVersions(db, t).canary).toEqual({ version: "1.0.0", percent: 25 });
    const ep = db.ml.endpoints.find((e) => e.bucket < 25 && e.state !== "incompatible")!;
    const r = run(db, { kind: "endpoint_checkin", integration_id: ep.integration_id ?? "int_ops", endpoint_id: ep.id, drill: true, health: { active_model: "1.0.0", inference_p95_ms: 31 } }, 4) as { auto_rollback?: unknown };
    expect(r.auto_rollback).toBeTruthy();
    expect(roleVersions(db, t).canary).toBeNull();
    expect(db.ml.models.find((m) => m.version === "1.0.0")!.history.at(-1)!.automatic).toBe(true);
    expect(db.ml.manifest_seq).toBeGreaterThan(seq0 + 3);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("issues manifests that verify with the published model-signing key and carry the policy hash", () => {
    const db = buildSeed(new Date("2026-10-04T18:00:00Z"));
    const m = signedManifest(db, db.ml.endpoints[0])!;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: db.ml.signing_key.x }, format: "jwk" });
    expect(verify(null, Buffer.from(m.payload), key, Buffer.from(m.signature, "base64"))).toBe(true);
    expect(verify(null, Buffer.from(m.payload.replace("production", "productiom")), key, Buffer.from(m.signature, "base64"))).toBe(false);
    const p = JSON.parse(m.payload);
    expect(p.feature_schema).toBe("edge-features/1");
    expect(p.policy_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("kill switch reverts every decision to deterministic policy; analyst labels never touch the live model", () => {
    const db = buildSeed(new Date("2026-10-04T18:00:00Z"));
    run(db, { kind: "ml_settings", user_id: admin, kill_switch: true }, 1);
    const res = run(db, { kind: "preflight", integration_id: "int_support", envelope: { request_id: "ks1", actor: { type: "agent", id: "support-copilot" }, action: { type: "invoke_tool", tool: "crm.lookup" }, resources: [{ type: "customer_record", classification: "restricted", count: 5000 }] } }, 2) as { action: { evaluation: { fusion?: { rule: string } }; prediction_id?: string } };
    expect(res.action.evaluation.fusion?.rule).toBe("model_unavailable_fallback");
    const before = JSON.stringify(db.ml.models);
    const pid = db.ml.predictions.find((p) => p.class)!.id;
    run(db, { kind: "ml_review", prediction_id: pid, label: "high_risk", user_id: admin }, 3);
    expect(db.ml.feedback.at(-1)).toMatchObject({ label_state: "analyst_reviewed", confidence: 0.95 });
    expect(JSON.stringify(db.ml.models)).toBe(before);
  });

  it("the model can raise an allowed action to a human (restricted bulk lookup) but never lowers a policy approval", () => {
    const db = buildSeed(new Date("2026-10-04T18:00:00Z"));
    const r = run(db, { kind: "preflight", integration_id: "int_support", envelope: { request_id: "esc1", actor: { type: "agent", id: "support-copilot" }, action: { type: "invoke_tool", tool: "crm.lookup" }, resources: [{ type: "customer_record", classification: "restricted", count: 20000 }] } }, 1) as { action: { evaluation: { deterministic_status?: string; status: string; fusion?: { changed: boolean } } } };
    expect(r.action.evaluation.deterministic_status).toBe("allow");
    expect(["warn", "approval_required"]).toContain(r.action.evaluation.status);
    expect(r.action.evaluation.fusion?.changed).toBe(true);
    const hero = run(db, { kind: "preflight", integration_id: "int_procurement", envelope: { request_id: "h1", actor: { type: "agent", id: "procurement-agent" }, action: { type: "external_send", tool: "llm.summarize" }, resources: [{ type: "document", classification: "confidential", count: 4 }], destination: { type: "external_model", value: "quickscribe-ai.app" } } }, 2) as { action: { evaluation: { status: string; fusion?: { rule: string } } } };
    expect(hero.action.evaluation.status).toBe("approval_required");
    expect(hero.action.evaluation.fusion?.rule).toBe("deterministic_approval_wins");
  });
});
