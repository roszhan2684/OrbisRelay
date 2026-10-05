import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/marketing/parts";
import { openapi } from "@/lib/openapi";

export const metadata: Metadata = { title: "Docs", description: "Orbis Relay quickstart, concepts, API reference and SDKs." };

const TOC = [
  ["quickstart", "Quickstart"],
  ["envelope", "Action envelope"],
  ["decisions", "Decision states"],
  ["policy", "Policy model"],
  ["approvals", "Approval lifecycle"],
  ["receipts", "Receipts"],
  ["webhooks", "Webhooks"],
  ["agents", "Agent adapter"],
  ["errors", "Errors"],
  ["reference", "API reference"],
] as const;

function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-line bg-night">
      {title && <div className="border-b border-white/10 px-4 py-2 font-mono text-[11.5px] text-white/45">{title}</div>}
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-[#d7defa]">{children}</pre>
    </div>
  );
}
function H({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="mt-16 scroll-mt-24 text-[26px] font-semibold tracking-[-0.025em] first:mt-0">{children}</h2>;
}
const P = ({ children }: { children: React.ReactNode }) => <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{children}</p>;

export default function Docs() {
  const paths = Object.entries(openapi.paths) as Array<[string, Record<string, { summary: string; security?: unknown[] }>]>;
  return (
    <div className="min-h-screen bg-page">
      <div className="bg-night pb-14 pt-32 text-white">
        <Nav />
        <div className="mx-auto max-w-[1180px] px-5">
          <div className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-[#8fa2ff]">Documentation</div>
          <h1 className="mt-3 text-[42px] font-semibold tracking-[-0.035em]">Build with Orbis Relay</h1>
          <p className="mt-3 max-w-[640px] text-[16px] text-white/60">Everything you need to ask “may I do this?” before your software acts — and to prove what happened afterwards.</p>
        </div>
      </div>
      <div className="mx-auto grid max-w-[1180px] gap-10 px-5 py-12 lg:grid-cols-[200px_1fr]">
        <nav className="hidden lg:block" aria-label="Docs">
          <ul className="sticky top-24 space-y-1 text-[14px]">
            {TOC.map(([id, l]) => (
              <li key={id}><a href={`#${id}`} className="block rounded-lg px-2.5 py-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink">{l}</a></li>
            ))}
          </ul>
        </nav>
        <article className="min-w-0 max-w-[760px]">
          <H id="quickstart">Quickstart</H>
          <P>1. Create a key in <Link className="text-cobalt hover:underline" href="/console/developer">Developer → API keys</Link> (the demo sandbox key works out of the box). 2. Call preflight right before the risky step. 3. Execute only what Orbis authorized, then report the outcome.</P>
          <Code title="TypeScript">{`import { OrbisClient } from "@orbis/sdk";
const orbis = new OrbisClient({ apiKey: process.env.ORBIS_API_KEY!, baseUrl: "http://localhost:4310" });

const decision = await orbis.preflight({ actor, action, resources, destination, intent });
if (decision.isAllowed()) await execute();
else if (decision.requiresApproval()) {
  const final = await decision.waitForResolution({ timeoutMs: 600_000 });
  if (final.approved) await execute(final.approvedParameters);
}
await orbis.reportOutcome(decision.actionId, "succeeded");`}</Code>
          <Code title="Python">{`from orbis_relay import OrbisClient
orbis = OrbisClient(api_key=os.environ["ORBIS_API_KEY"], base_url="http://localhost:4310")
d = orbis.preflight(actor=..., action=..., resources=[...], destination=..., intent=...)
if d.is_allowed: execute()
elif d.requires_approval:
    final = d.wait_for_resolution(timeout=600)
    if final.approved: execute(final.approved_parameters)`}</Code>

          <H id="envelope">Action envelope</H>
          <P>Describe the action, not its payload. Orbis never needs raw documents or secrets — send classifications, counts, amounts and a redacted summary. The tenant is derived from your API key, never from the body.</P>
          <Code title="POST /v1/decisions/preflight">{`{
  "request_id": "req_01J…",            // idempotency key
  "actor": { "type": "agent", "id": "procurement-agent", "owner": "finance" },
  "action": { "type": "external_send", "tool": "llm.summarize", "arguments_summary": "4 vendor contracts" },
  "resources": [{ "type": "document", "classification": "confidential", "count": 4 }],
  "destination": { "type": "external_model", "value": "quickscribe-ai.app" },
  "intent": { "reason": "Respond to vendor RFP", "source": "agent" },
  "business_context": { "deal_id": "D-82" },
  "signals": { "incident_active": false },
  "evidence": [{ "label": "Data class", "value": "Confidential — pricing terms", "source": "DLP" }],
  "blast_radius": ["4 contracts leave the trust boundary"],
  "ttl_seconds": 600
}`}</Code>

          <H id="decisions">Decision states</H>
          <Code>{`received → evaluating → allow | warn | deny | approval_required
approval_required → pending → approved | approved_modified | rejected | expired | cancelled
final authorization → outcome: succeeded | failed | not_executed | unknown`}</Code>
          <P><b>approved_modified</b> means a human edited parameters or chose a safe alternative. Always execute with <code>approved_parameters</code> — e.g. the redirected destination.</P>

          <H id="policy">Policy model</H>
          <P>Policies are versioned rule sets. Published versions are immutable; drafts are simulated against real history and published with a second admin. Every enabled policy is evaluated; the most severe matching effect wins: <code>allow &lt; allow_log &lt; warn &lt; require_confirmation &lt; require_approval &lt; require_quorum &lt; deny &lt; freeze</code>. A frozen actor is always denied.</P>
          <Code title="rule">{`{
  "id": "ext_model_confidential",
  "when": { "all": [
    { "field": "destination.type", "op": "eq", "value": "external_model" },
    { "field": "resource.classification_rank", "op": "gte", "value": 2 },
    { "field": "destination.approved", "op": "neq", "value": true } ] },
  "effect": "require_approval", "route": "ai-governance", "step_up": "biometric",
  "safe_alternatives": [{ "id": "redirect_internal_model", "type": "redirect",
    "apply": { "destination": "northstar-private-llm" } }]
}`}</Code>
          <P>The risk score (0–100) prioritizes and routes. It never overrides a hard rule, and core enforcement never calls a model.</P>

          <H id="approvals">Approval lifecycle</H>
          <P>Approvals route to a group (resource owner, role, on-call). The server verifies assignment, tenant, state, expiry and required step-up before any response mutates state. SLA escalation fires at 50% of TTL; quorum rules require N distinct approvers; any rejection rejects. Push notifications carry only a title and a deep link.</P>

          <H id="receipts">Receipts</H>
          <P>Every final decision yields a receipt: canonical JSON (sorted keys) signed with Ed25519, plus its SHA-256. Reporting an outcome issues revision 2, which commits to revision 1's hash. Verify with <code>POST /v1/receipts/:id/verify</code>, offline with the JWK at <code>/v1/receipts/public-key</code>, or on the <Link className="text-cobalt hover:underline" href="/verify">verifier page</Link>.</P>

          <H id="webhooks">Webhooks</H>
          <Code title="Orbis-Signature header">{`Orbis-Signature: t=1791234567,v1=5f2b…   // HMAC-SHA256(secret, t + "." + rawBody)

import { verifyWebhookSignature } from "@orbis/sdk";
if (!(await verifyWebhookSignature(secret, req.headers["orbis-signature"], rawBody))) return 401;`}</Code>
          <P>Reject if the timestamp is more than 5 minutes old, compare in constant time, and dedupe on <code>Idempotency-Key</code>. Callback URLs must be public https endpoints — private, loopback and link-local addresses are rejected.</P>

          <H id="agents">Agent adapter</H>
          <Code title="TypeScript">{`import { createAgentAdapter } from "@orbis/sdk";
const adapter = createAgentAdapter(orbis, { type: "agent", id: "procurement-agent" });
const summarize = adapter.wrap({
  name: "llm.summarize",
  classify: (a) => ({ action: { type: "external_send" }, resources: [{ type: "document", classification: a.classification, count: a.docs.length }],
                      destination: { type: "external_model", value: a.provider } }),
  applyApproved: (a, p) => ({ ...a, provider: String(p.destination ?? a.provider) }),
  run: (a) => llm.summarize(a),
});
// Denials throw ToolBlockedError — the agent can explain and re-plan.`}</Code>

          <H id="errors">Errors</H>
          <Code>{`{ "error": { "code": "step_up_required", "message": "…", "remediation": "Complete Face ID and resubmit." } }

401 unauthenticated · invalid_key · key_revoked     403 not_assigned · forbidden · device_not_trusted
404 not_found     409 already_resolved · idempotency_conflict     410 expired
413 payload_too_large     422 validation_error · field_not_editable · out_of_range     428 step_up_required`}</Code>

          <H id="reference">API reference</H>
          <P>Machine-readable contract: <a className="text-cobalt hover:underline" href="/api/v1/openapi">/api/v1/openapi</a> (OpenAPI 3.1).</P>
          <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface">
            <table className="w-full text-[13.5px]">
              <tbody className="divide-y divide-line">
                {paths.flatMap(([p, ops]) =>
                  Object.entries(ops).map(([m, op]) => (
                    <tr key={m + p}>
                      <td className="w-20 px-4 py-2.5"><span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${m === "get" ? "bg-low-bg text-low" : m === "delete" ? "bg-critical-bg text-critical" : "bg-cobalt-50 text-cobalt"}`}>{m.toUpperCase()}</span></td>
                      <td className="px-2 py-2.5 font-mono text-[12.5px]">/v1{p}</td>
                      <td className="px-4 py-2.5 text-ink-2">{op.summary}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </div>
  );
}
