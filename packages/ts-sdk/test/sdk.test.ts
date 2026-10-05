import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentAdapter, OrbisClient, OrbisError, ToolBlockedError, verifyWebhookSignature } from "../src";

const BASE = process.env.ORBIS_BASE_URL ?? "http://localhost:4310";
const KEY = process.env.ORBIS_API_KEY ?? "orb_test_np_sandbox_e5b1c9a3f7d2084b6c3e";
const up = await fetch(`${BASE}/api/v1/receipts/public-key`).then((r) => r.ok, () => false);

describe("webhooks", () => {
  it("verifies signature and rejects replays", async () => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "whsec").update(`${t}.{}`).digest("hex");
    expect(await verifyWebhookSignature("whsec", `t=${t},v1=${v1}`, "{}")).toBe(true);
    expect(await verifyWebhookSignature("whsec", `t=${t - 900},v1=${v1}`, "{}")).toBe(false);
    expect(await verifyWebhookSignature("nope", `t=${t},v1=${v1}`, "{}")).toBe(false);
  });
});

describe.skipIf(!up)("against local gateway", () => {
  const orbis = new OrbisClient({ apiKey: KEY, baseUrl: BASE });

  it("serialized decisions never contain the API key", async () => {
    const d = await orbis.preflight({ actor: { type: "agent", id: "sandbox-agent" }, action: { type: "invoke_tool" }, resources: [{ type: "doc", classification: "internal" }] });
    expect(JSON.stringify(d)).not.toContain(KEY);
    expect(d.isAllowed()).toBe(true);
  });

  it("approval_required for large refunds", async () => {
    const d = await orbis.preflight({ actor: { type: "agent", id: "sandbox-agent" }, action: { type: "refund" }, resources: [{ type: "order" }], business_context: { amount_usd: 9000 }, intent: { reason: "SLA credit after outage" } });
    expect(d.requiresApproval()).toBe(true);
    expect(d.approval?.route).toBe("support-manager");
    await orbis.cancelApproval(d.approval!.id);
    const r = await d.waitForResolution({ timeoutMs: 3000, pollMs: 200 });
    expect(r).toMatchObject({ approved: false, status: "cancelled" });
  });

  it("agent adapter blocks denied tools and never runs them", async () => {
    let ran = false;
    const adapter = createAgentAdapter(orbis, { type: "agent", id: "sandbox-agent" });
    const drop = adapter.wrap({ name: "db.delete", classify: () => ({ action: { type: "delete" }, resources: [{ type: "table", environment: "production" }] }), run: async () => void (ran = true) });
    await expect(drop({})).rejects.toBeInstanceOf(ToolBlockedError);
    expect(ran).toBe(false);
  });

  it("typed errors with remediation", async () => {
    const bad = new OrbisClient({ apiKey: "orb_live_nope", baseUrl: BASE, maxRetries: 0 });
    await expect(bad.preflight({ actor: { type: "agent", id: "x" }, action: { type: "refund" }, resources: [] })).rejects.toBeInstanceOf(OrbisError);
  });
});
