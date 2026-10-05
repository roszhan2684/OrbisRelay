import { describe, expect, it } from "vitest";
import { buildSeed, heroEnvelope } from "../seed";
import { applyOp, type OpEnvelope } from "../ops";
import { tick } from "../gateway";
import type { PreflightResult } from "../gateway";
import { verifyAuditChain } from "../store";

// Two serverless replicas: A executes ops live; B replays the same op log later. They must converge.
describe("op-log replication", () => {
  const anchor = new Date("2026-10-05T08:00:00Z");
  const a = buildSeed(anchor);
  const b = buildSeed(anchor);
  const log: OpEnvelope[] = [];
  const run = (op: OpEnvelope["op"], at: string) => {
    const env: OpEnvelope = { id: `op_test${log.length}`, at, op };
    log.push(env);
    return applyOp(a, env);
  };

  it("converges to byte-identical state", () => {
    const pf = run({ kind: "preflight", integration_id: "int_procurement", envelope: heroEnvelope("req_replica_1") }, "2026-10-05T08:10:00.000Z") as PreflightResult;
    expect(pf.approval).toBeTruthy();
    run({ kind: "respond", approval_id: pf.approval!.id, user_id: "usr_alex_chen", input: { decision: "safe_alternative", alternative_id: "redirect_internal_model", step_up: { method: "biometric", verified: true, device_id: "dev_alex_chen" }, channel: "ios" } }, "2026-10-05T08:10:30.000Z");
    run({ kind: "outcome", action_id: pf.action.id, integration_id: "int_procurement", status: "succeeded" }, "2026-10-05T08:10:45.000Z");
    run({ kind: "freeze", actor_id: "ops-agent", user_id: "usr_alex_chen", reason: "drill", channel: "web" }, "2026-10-05T08:11:00.000Z");
    run({ kind: "protect", analysis: { id: "pa_x", tenant_id: a.tenant.id, user_id: "usr_alex_chen", kind: "url", input_preview: "x", verdict: "safe", score: 1, recommendation: "ok", reasons: [], model: [], created_at: "2026-10-05T08:12:00.000Z", channel: "web" } }, "2026-10-05T08:12:00.000Z");
    tick(a, new Date("2026-10-05T09:00:00Z"), { silent: true });
    tick(a, new Date("2026-10-05T09:30:00Z"), { silent: true });

    for (const env of log) applyOp(b, env);
    tick(b, new Date("2026-10-05T09:30:00Z"), { silent: true }); // B never ran the 09:00 tick
    const strip = (d: typeof a) => JSON.stringify({ ...d, audit: d.audit.map((e) => e.summary).sort() });
    expect(strip(b)).toBe(strip(a));
    expect(b.receipts.at(-1)?.signature).toBe(a.receipts.at(-1)?.signature);
    expect(verifyAuditChain(a).ok && verifyAuditChain(b).ok).toBe(true);
  });
});
