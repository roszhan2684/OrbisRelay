"use client";
import * as React from "react";
import { ReceiptVerifier, type ReceiptExport } from "@/components/receipt-verifier";
import { Button, inputCls } from "@/components/ui";
import { cn } from "@/lib/format";

export function VerifyTool() {
  const [text, setText] = React.useState("");
  const [r, setR] = React.useState<ReceiptExport | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const parse = () => {
    try {
      const j = JSON.parse(text);
      if (!j.body || !j.signature) throw new Error("Expected { body, body_hash, signature, key_id, alg }");
      setErr(null);
      setR({ id: j.id ?? j.body.receipt_id, body: j.body, body_hash: j.body_hash, signature: j.signature, key_id: j.key_id, alg: j.alg ?? "Ed25519" });
    } catch (e) {
      setErr((e as Error).message);
      setR(null);
    }
  };
  return (
    <div className="space-y-4">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} placeholder='{"id":"rcp_…","body":{…},"body_hash":"…","signature":"…","key_id":"…","alg":"Ed25519"}' className={cn(inputCls, "h-auto py-3 font-mono text-[12px]")} aria-label="Receipt JSON" />
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={parse} disabled={!text.trim()}>Verify receipt</Button>
        <span className="text-[13px] text-muted">Download a receipt from any receipt page in the console (⬇ button).</span>
      </div>
      {err && <p className="text-[13px] text-critical">{err}</p>}
      {r && <ReceiptVerifier key={r.signature + JSON.stringify(r.body).length} receipt={r} />}
    </div>
  );
}
