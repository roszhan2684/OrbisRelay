"use client";
import * as React from "react";
import { Check, Copy, KeyRound, Loader2, Play, Plus, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/components/console/live";
import { RelTime } from "@/components/console/time";
import { Badge, Button, Card, CardHeader, Mono, RiskBadge, Segmented, StatusBadge, inputCls } from "@/components/ui";
import { cn } from "@/lib/format";

const PRESETS: Record<string, object> = {
  "AI tool call": {
    actor: { type: "agent", id: "sandbox-agent" },
    action: { type: "external_send", tool: "llm.summarize", title: "Send 4 contracts to external AI", arguments_summary: "4 confidential vendor contracts" },
    resources: [{ type: "document", classification: "confidential", count: 4 }],
    destination: { type: "external_model", value: "openwrite-ai.com" },
    intent: { reason: "Summarize vendor contracts for RFP response", source: "agent" },
    ttl_seconds: 900,
  },
  "Refund $8,500": {
    actor: { type: "agent", id: "sandbox-agent" },
    action: { type: "refund", tool: "billing.refund", parameters: { amount_usd: 8500 } },
    resources: [{ type: "order", classification: "internal" }],
    business_context: { amount_usd: 8500, ticket: "ZD-1" },
    intent: { reason: "SLA credit after outage", source: "agent" },
  },
  "Small refund": {
    actor: { type: "agent", id: "sandbox-agent" },
    action: { type: "refund", tool: "billing.refund" },
    resources: [{ type: "order" }],
    business_context: { amount_usd: 120 },
    intent: { reason: "Duplicate charge", source: "agent" },
  },
  "Bulk export": {
    actor: { type: "workflow", id: "sandbox-agent" },
    action: { type: "data_export", tool: "warehouse.export" },
    resources: [{ type: "customer_table", classification: "confidential" }],
    business_context: { record_count: 120000 },
    intent: { reason: "Ad-hoc analysis", source: "workflow" },
  },
};

export function DeveloperView({ sandboxKey, base, integrations }: { sandboxKey: string; base: string; integrations: Array<{ id: string; name: string }> }) {
  const [lang, setLang] = React.useState<"ts" | "py" | "swift" | "curl">("ts");
  const [preset, setPreset] = React.useState("AI tool call");
  const [body, setBody] = React.useState(JSON.stringify(PRESETS["AI tool call"], null, 2));
  const [resp, setResp] = React.useState<{ status: number; ms: number; json: unknown } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [requests, setRequests] = React.useState<Array<{ id: string; title: string; final_status: string; risk: { level: string; score: number }; received_at: string; request_id: string; latency_ms: number }>>([]);
  const [hookUrl, setHookUrl] = React.useState("https://hooks.northstar.cloud/orbis");
  const [hook, setHook] = React.useState<null | { valid: boolean; reason: string | null; request: { headers: Record<string, string>; body: string } | null; verification: string }>(null);
  const [newKey, setNewKey] = React.useState<{ plaintext: string; prefix: string } | null>(null);
  const [keyInt, setKeyInt] = React.useState("int_sandbox");

  const loadRequests = React.useCallback(async () => setRequests((await api<{ data: typeof requests }>("/api/v1/developer/requests?integration=int_sandbox")).data), []);
  React.useEffect(() => {
    api<{ data: typeof requests }>("/api/v1/developer/requests?integration=int_sandbox").then((r) => setRequests(r.data));
  }, []);

  const send = async () => {
    setBusy(true);
    const t = performance.now();
    try {
      const parsed = JSON.parse(body);
      const r = await fetch("/api/v1/decisions/preflight", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sandboxKey}` }, body: JSON.stringify({ ...parsed, request_id: `req_sandbox_${Date.now().toString(36)}` }) });
      setResp({ status: r.status, ms: Math.round(performance.now() - t), json: await r.json() });
      void loadRequests();
    } catch (e) {
      setResp({ status: 0, ms: 0, json: { error: (e as Error).message } });
    } finally {
      setBusy(false);
    }
  };

  const code = {
    ts: `import { OrbisClient } from "@orbis/sdk";

const orbis = new OrbisClient({ apiKey: process.env.ORBIS_API_KEY!, baseUrl: "${base}" });

const decision = await orbis.preflight({
  actor: { type: "agent", id: "procurement-agent" },
  action: { type: "external_send", tool: "llm.summarize" },
  resources: [{ type: "document", classification: "confidential", count: 4 }],
  destination: { type: "external_model", value: "openwrite-ai.com" },
  intent: { reason: "Summarize vendor contracts for RFP response" },
});

if (decision.isAllowed()) await execute();
else if (decision.requiresApproval()) {
  const final = await decision.waitForResolution({ timeoutMs: 600_000 });
  if (final.approved) await execute(final.approvedParameters); // honors safe redirects
}
await orbis.reportOutcome(decision.actionId, "succeeded");`,
    py: `from orbis_relay import OrbisClient

orbis = OrbisClient(api_key=os.environ["ORBIS_API_KEY"], base_url="${base}")

decision = orbis.preflight(
    actor={"type": "agent", "id": "procurement-agent"},
    action={"type": "external_send", "tool": "llm.summarize"},
    resources=[{"type": "document", "classification": "confidential", "count": 4}],
    destination={"type": "external_model", "value": "openwrite-ai.com"},
    intent={"reason": "Summarize vendor contracts for RFP response"},
)
if decision.is_allowed:
    execute()
elif decision.requires_approval:
    final = decision.wait_for_resolution(timeout=600)
    if final.approved:
        execute(final.approved_parameters)
orbis.report_outcome(decision.action_id, "succeeded")`,
    swift: `import OrbisRelay

let orbis = OrbisClient(apiKey: apiKey, baseURL: URL(string: "${base}")!)
let decision = try await orbis.preflight(.init(
  actor: .init(type: .agent, id: "procurement-agent"),
  action: .init(type: .externalSend, tool: "llm.summarize"),
  resources: [.init(type: "document", classification: .confidential, count: 4)],
  destination: .init(type: .externalModel, value: "openwrite-ai.com")
))
switch decision.status {
case .allow, .warn: try await execute()
case .approvalRequired:
  let final = try await decision.waitForResolution(timeout: .seconds(600))
  if final.approved { try await execute(final.approvedParameters) }
case .deny: break
}`,
    curl: `curl -X POST ${base}/api/v1/decisions/preflight \\
  -H "Authorization: Bearer $ORBIS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "request_id": "req_123",
    "actor": {"type":"agent","id":"procurement-agent"},
    "action": {"type":"external_send","tool":"llm.summarize"},
    "resources": [{"type":"document","classification":"confidential","count":4}],
    "destination": {"type":"external_model","value":"openwrite-ai.com"},
    "intent": {"reason":"Summarize vendor contracts for RFP response"}
  }'`,
  }[lang];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <Card>
          <CardHeader title="Quickstart" description="One call before the risky step. Typical integration: under 15 minutes." action={<Segmented value={lang} onChange={setLang} options={[{ value: "ts", label: "TypeScript" }, { value: "py", label: "Python" }, { value: "swift", label: "Swift" }, { value: "curl", label: "cURL" }]} />} />
          <div className="relative">
            <CopyBtn text={code} className="absolute right-3 top-3" />
            <pre className="max-h-[440px] overflow-auto bg-night p-5 font-mono text-[12.5px] leading-relaxed text-[#d7defa]">{code}</pre>
          </div>
        </Card>
        <Card>
          <CardHeader title="Sandbox playground" description="Real gateway, sandbox integration — nothing touches production." action={<Badge tone="neutral">int_sandbox</Badge>} />
          <div className="space-y-3 p-5">
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(PRESETS).map((p) => (
                <button key={p} onClick={() => (setPreset(p), setBody(JSON.stringify(PRESETS[p], null, 2)))} className={cn("rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset", preset === p ? "bg-ink text-white ring-ink" : "bg-surface text-ink-2 ring-line")}>{p}</button>
              ))}
            </div>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} spellCheck={false} className={cn(inputCls, "h-auto py-2.5 font-mono text-[12px] leading-relaxed")} aria-label="Action envelope JSON" />
            <Button variant="primary" onClick={send} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} POST /v1/decisions/preflight</Button>
            {resp && (
              <div>
                <div className="mb-1 flex items-center gap-2 text-[12px]"><Badge tone={resp.status < 300 ? "low" : "critical"}>{resp.status}</Badge><span className="text-muted">{resp.ms}ms round-trip</span></div>
                <pre className="max-h-64 overflow-auto rounded-xl bg-night p-3 font-mono text-[11.5px] text-white/85">{JSON.stringify(resp.json, null, 2)}</pre>
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Request inspector" description="Last 25 sandbox requests, as the gateway saw them" action={<Button size="sm" variant="ghost" onClick={loadRequests}><RefreshCw className="size-4" /></Button>} />
          {requests.length === 0 ? (
            <p className="px-5 py-10 text-center text-[13.5px] text-muted">No sandbox requests yet — send one from the playground.</p>
          ) : (
            <table className="w-full text-[13px]">
              <tbody className="divide-y divide-line">
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-2"><div className="font-medium">{r.title}</div><Mono className="text-[11px] text-faint">{r.request_id}</Mono></td>
                    <td className="px-3"><StatusBadge status={r.final_status} /></td>
                    <td className="px-3"><RiskBadge level={r.risk.level} score={r.risk.score} /></td>
                    <td className="tnum px-3 text-[12px] text-muted">{r.latency_ms}ms</td>
                    <td className="px-5 text-right text-[12px] text-muted"><RelTime iso={r.received_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title={<span className="flex items-center gap-1.5"><KeyRound className="size-4" /> API keys</span>} description="Hashed at rest · shown once" />
            <div className="space-y-3 p-5">
              <div className="rounded-xl bg-surface-2 px-3.5 py-2.5">
                <div className="text-[12px] text-muted">Sandbox key (demo)</div>
                <div className="mt-0.5 flex items-center justify-between gap-2"><Mono className="truncate">{sandboxKey}</Mono><CopyBtn text={sandboxKey} /></div>
              </div>
              <div className="flex gap-2">
                <select value={keyInt} onChange={(e) => setKeyInt(e.target.value)} className={cn(inputCls, "h-9 text-[13px]")} aria-label="Integration for new key">
                  {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
                <Button size="sm" className="h-9" onClick={async () => { const k = await api<{ plaintext: string; prefix: string }>("/api/v1/developer/keys", { method: "POST", json: { integration_id: keyInt, label: "Created in developer portal" } }); setNewKey(k); toast.success("Key created — copy it now"); }}><Plus className="size-4" /> Create</Button>
              </div>
              {newKey && (
                <div className="rounded-xl border border-medium/30 bg-medium-bg px-3.5 py-2.5 text-[12.5px]">
                  <div className="font-medium text-medium">Copy now — it won't be shown again</div>
                  <div className="mt-1 flex items-center justify-between gap-2"><Mono className="truncate">{newKey.plaintext}</Mono><CopyBtn text={newKey.plaintext} /></div>
                </div>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title={<span className="flex items-center gap-1.5"><Webhook className="size-4" /> Webhook tester</span>} description="SSRF rules + the exact signed request" />
            <div className="space-y-2.5 p-5">
              <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} className={cn(inputCls, "h-9 font-mono text-[12px]")} aria-label="Webhook URL" />
              <div className="flex flex-wrap gap-1.5">
                {["https://hooks.northstar.cloud/orbis", "http://169.254.169.254/latest", "https://localhost/hook"].map((u) => <button key={u} onClick={() => setHookUrl(u)} className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-2 ring-1 ring-inset ring-line">{u.replace("https://", "").replace("http://", "")}</button>)}
              </div>
              <Button size="sm" onClick={async () => setHook(await api("/api/v1/webhooks/test", { method: "POST", json: { url: hookUrl }, headers: { authorization: `Bearer ${sandboxKey}` } }))}>Test endpoint</Button>
              {hook && (hook.valid ? (
                <div className="space-y-1 text-[12px]">
                  <Badge tone="low"><Check className="size-3.5" /> Allowed destination</Badge>
                  <pre className="overflow-auto rounded-lg bg-night p-2.5 font-mono text-[10.5px] text-white/85">{Object.entries(hook.request!.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}{"\n\n"}{hook.request!.body}</pre>
                  <p className="text-muted">{hook.verification}</p>
                </div>
              ) : <Badge tone="critical">Blocked: {hook.reason}</Badge>)}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CopyBtn({ text, className }: { text: string; className?: string }) {
  const [ok, setOk] = React.useState(false);
  return (
    <button className={cn("rounded-md p-1.5 text-faint hover:bg-white/10 hover:text-ink-2", className)} onClick={() => { void navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }} aria-label="Copy">
      {ok ? <Check className="size-4 text-low" /> : <Copy className="size-4" />}
    </button>
  );
}
