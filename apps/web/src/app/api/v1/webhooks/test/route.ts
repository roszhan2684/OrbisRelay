import { requireIntegration } from "@/lib/server/auth";
import { signWebhook } from "@/lib/server/crypto";
import { validateCallbackUrl } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";

/**
 * POST /v1/webhooks/test — validate a callback endpoint (SSRF rules) and show the exact signed
 * request Orbis would send. The demo backend does not make outbound calls.
 */
export const POST = handle(async (req: Request) => {
  const { integration } = await requireIntegration(req);
  const body = await readJson(req);
  const url = String(body.url ?? "");
  const v = validateCallbackUrl(url);
  const payload = JSON.stringify({ type: "webhook.test", integration_id: integration.id, sent_at: new Date().toISOString() });
  const secret = `whsec_demo_${integration.id}`;
  return json({
    url,
    valid: v.ok,
    reason: v.ok ? null : v.reason,
    request: v.ok
      ? { method: "POST", headers: { "Content-Type": "application/json", "Orbis-Signature": signWebhook(secret, payload), "Orbis-Event": "webhook.test", "Idempotency-Key": `evt_${Date.now().toString(36)}` }, body: payload }
      : null,
    verification: "Recompute HMAC-SHA256(secret, `${t}.${body}`), compare in constant time, reject if |now - t| > 300s.",
  });
});
