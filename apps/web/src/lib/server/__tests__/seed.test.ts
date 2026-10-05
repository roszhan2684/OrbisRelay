import { describe, expect, it } from "vitest";
import { buildSeed } from "../seed";
import { verifyAuditChain } from "../store";
import { verifyReceipt } from "../gateway";

describe("seeded demo organization", () => {
  const t0 = performance.now();
  const db = buildSeed(new Date("2026-10-04T18:00:00Z"));
  const ms = performance.now() - t0;

  it("builds quickly with realistic volume", () => {
    const by = (k: string) => db.actions.filter((a) => a.final_status === k).length;
    console.log({ ms: Math.round(ms), actions: db.actions.length, approvals: db.approvals.length, receipts: db.receipts.length, audit: db.audit.length, pending: db.approvals.filter((a) => a.status === "pending").length,
      allow: by("allow"), warn: by("warn"), deny: by("deny"), approved: by("approved"), approved_modified: by("approved_modified"), rejected: by("rejected"), expired: by("expired"), cancelled: by("cancelled"), pendingA: by("pending"),
      bytes: JSON.stringify(db).length });
    expect(db.actions.length).toBeGreaterThan(800);
  });

  it("audit chain verifies", () => {
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("every receipt signature verifies", () => {
    for (const r of db.receipts) expect(verifyReceipt(db, r).valid).toBe(true);
  });

  it("audit is chronological (append order; decision latency may skew timestamps by <1s)", () => {
    // Scheduled lifecycle events (escalation/expiry) are stamped at their due time, so they may be appended late.
    const ordered = db.audit.filter((e) => e.type !== "approval.escalated" && !(e.type === "approval.resolved" && e.summary.includes("expired")));
    for (let i = 1; i < ordered.length; i++) expect(new Date(ordered[i].at).getTime() - new Date(ordered[i - 1].at).getTime(), `${ordered[i - 1].summary} > ${ordered[i].summary}`).toBeGreaterThan(-1000);
  });

  it("has the curated pending inbox", () => {
    const titles = db.approvals.filter((a) => a.status === "pending").map((a) => `${a.title} [${a.responses.length}${a.quorum ? "/" + a.quorum.required : ""}] esc=${a.escalation_level}`);
    console.log(titles);
    expect(titles.length).toBeGreaterThanOrEqual(9);
  });

  it("is deterministic across instances (same anchor → identical tenant and signatures)", () => {
    const again = buildSeed(new Date("2026-10-04T18:00:00Z"));
    expect(JSON.stringify(again)).toBe(JSON.stringify(db));
  });

  it("growth agent is frozen and blocking", () => {
    const fr = db.freezes.find((f) => f.actor_id === "growth-agent" && !f.lifted_at);
    expect(fr).toBeTruthy();
    console.log("blocked", fr?.blocked_count, "freezes", db.freezes.length);
  });
});
