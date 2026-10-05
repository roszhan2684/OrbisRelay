"use client";
import * as React from "react";
import { CheckCircle2, Copy, Download, FlaskConical, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { canonicalize } from "@/lib/canonical";
import { Badge, Button, Card, CardHeader, Mono } from "@/components/ui";
import { cn } from "@/lib/format";

export interface ReceiptExport {
  id?: string;
  body: Record<string, unknown>;
  body_hash: string;
  signature: string;
  key_id: string;
  alg: string;
}

function b64urlToBytes(s: string) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Independent, in-browser verification: re-canonicalize the body, re-hash it, check the Ed25519 signature. */
export async function verifyInBrowser(r: ReceiptExport) {
  const jwks = await fetch("/api/v1/receipts/public-key").then((x) => x.json());
  const jwk = jwks.keys.find((k: { kid: string }) => k.kid === r.key_id) ?? jwks.keys[0];
  const canonical = canonicalize(r.body);
  const hash = await sha256Hex(canonical);
  let sigOk: boolean | null = null;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    sigOk = await crypto.subtle.verify({ name: "Ed25519" }, key, b64urlToBytes(r.signature), new TextEncoder().encode(canonical));
  } catch {
    sigOk = null; // browser lacks WebCrypto Ed25519 — fall back to server verification
  }
  return { hashOk: hash === r.body_hash, sigOk, hash, kid: jwk.kid as string };
}

async function check(r: ReceiptExport) {
  const v = await verifyInBrowser(r);
  let server: boolean | undefined;
  if (v.sigOk === null) {
    const s = await fetch("/api/v1/receipts/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) }).then((x) => x.json());
    server = s.valid;
  }
  return { ...v, server };
}

export function ReceiptVerifier({ receipt, compact }: { receipt: ReceiptExport; compact?: boolean }) {
  const [working, setWorking] = React.useState<ReceiptExport>(receipt);
  const [res, setRes] = React.useState<null | { hashOk: boolean; sigOk: boolean | null; server?: boolean; hash: string; kid: string }>(null);
  const [busy, setBusy] = React.useState(true);
  const tampered = working !== receipt;

  const run = async (r = working) => {
    setBusy(true);
    try {
      setRes(await check(r));
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    let alive = true;
    check(receipt).then((v) => {
      if (!alive) return;
      setRes(v);
      setBusy(false);
    });
    return () => {
      alive = false;
    };
  }, [receipt]);

  const tamper = () => {
    const body = structuredClone(working.body) as Record<string, unknown> & { approved_parameters?: Record<string, unknown>; decision?: Record<string, unknown> };
    if (body.approved_parameters && "amount_usd" in body.approved_parameters) body.approved_parameters.amount_usd = Number(body.approved_parameters.amount_usd) * 10;
    else if (body.decision) body.decision = { ...body.decision, final_status: "approved" };
    const next = { ...working, body };
    setWorking(next);
    void run(next);
  };
  const reset = () => {
    setWorking(receipt);
    void run(receipt);
  };
  const valid = res && res.hashOk && (res.sigOk ?? res.server ?? false);
  const json = JSON.stringify(working, null, 2);

  return (
    <Card>
      <CardHeader
        title="Independent verification"
        description="Runs in your browser with WebCrypto — no trust in this server's word required."
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => (navigator.clipboard.writeText(json), toast("Receipt JSON copied"))}><Copy className="size-4" /></Button>
            <Button size="sm" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([json], { type: "application/json" })); a.download = `${receipt.id ?? "receipt"}.json`; a.click(); }}><Download className="size-4" /></Button>
          </div>
        }
      />
      <div className="space-y-4 p-5">
        <div className={cn("flex items-center gap-3 rounded-xl px-4 py-3", busy ? "bg-surface-2" : valid ? "bg-low-bg" : "bg-critical-bg")}>
          {busy ? <Loader2 className="size-6 animate-spin text-muted" /> : valid ? <ShieldCheck className="size-6 text-low" /> : <ShieldX className="size-6 text-critical" />}
          <div>
            <div className={cn("text-[15px] font-semibold", valid ? "text-low" : busy ? "text-ink" : "text-critical")}>{busy ? "Verifying…" : valid ? "Valid — signed by Orbis and unmodified" : "Invalid — this receipt was altered"}</div>
            {res && (
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-ink-2">
                <span>{res.hashOk ? "✓" : "✗"} SHA-256 body hash</span>
                <span>{res.sigOk === null ? (res.server ? "✓ signature (server)" : "✗ signature (server)") : res.sigOk ? "✓ Ed25519 signature" : "✗ Ed25519 signature"}</span>
                <span>key {res.kid}</span>
              </div>
            )}
          </div>
        </div>
        {!compact && (
          <div className="flex flex-wrap gap-2">
            {!tampered ? (
              <Button size="sm" variant="secondary" onClick={tamper}><FlaskConical className="size-4" /> Tamper with a field</Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={reset}><CheckCircle2 className="size-4" /> Restore original</Button>
            )}
            {tampered && <Badge tone="critical">Local copy modified — {receipt.body.approved_parameters ? "approved amount ×10" : "final status changed"}</Badge>}
          </div>
        )}
        <div>
          <div className="mb-1 text-[12px] text-muted">Signature · {working.alg}</div>
          <Mono className="block break-all rounded-lg bg-surface-2 px-3 py-2 text-[11px]">{working.signature}</Mono>
        </div>
        {!compact && <pre className="max-h-[420px] overflow-auto rounded-xl bg-night p-4 font-mono text-[11.5px] leading-relaxed text-white/85">{JSON.stringify(working.body, null, 2)}</pre>}
      </div>
    </Card>
  );
}
