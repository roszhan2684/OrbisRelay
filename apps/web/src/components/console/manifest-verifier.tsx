"use client";
import * as React from "react";
import { BadgeCheck, ShieldAlert, Wand2 } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/format";

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

/** Verifies a signed model manifest in the browser exactly as the Swift endpoint does: Ed25519 over the payload bytes. */
export function ManifestVerifier({ manifest, publicKeyX }: { manifest: { payload: string; signature: string; key_id: string }; publicKeyX: string }) {
  const [payload, setPayload] = React.useState(manifest.payload);
  const [state, setState] = React.useState<"checking" | "valid" | "invalid" | "unsupported">("checking");
  React.useEffect(() => {
    let live = true;
    (async () => {
      try {
        const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKeyX }, { name: "Ed25519" }, false, ["verify"]);
        const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64(manifest.signature), new TextEncoder().encode(payload));
        if (live) setState(ok ? "valid" : "invalid");
      } catch {
        if (live) setState("unsupported");
      }
    })();
    return () => {
      live = false;
    };
  }, [payload, manifest.signature, publicKeyX]);
  const parsed = React.useMemo(() => {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [payload]);
  const tamper = () => setPayload((p) => (p.includes('"stage":"production"') ? p.replace('"stage":"production"', '"stage":"productiom"') : p.replace(/"manifest_seq":(\d+)/, (_, n) => `"manifest_seq":${Number(n) + 1}`)));
  return (
    <div>
      <div className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium", state === "valid" ? "bg-low-bg text-low" : state === "invalid" ? "bg-critical-bg text-critical" : "bg-surface-2 text-muted")}>
        {state === "valid" ? <BadgeCheck className="size-4" /> : <ShieldAlert className="size-4" />}
        {state === "valid" ? `Ed25519 signature valid · key ${manifest.key_id}` : state === "invalid" ? "Signature INVALID — an endpoint would refuse this manifest" : state === "unsupported" ? "This browser lacks WebCrypto Ed25519; endpoints verify with CryptoKit" : "Verifying…"}
      </div>
      {parsed && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
          {["manifest_seq", "version", "stage", "feature_schema", "runtime", "minimum_app_version", "artifact_sha256", "policy_sha256", "expires_at", "rollback_to", "kill_switch"].map((k) => (
            <React.Fragment key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="truncate font-mono text-ink-2" title={String(parsed[k])}>{String(parsed[k])}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="secondary" onClick={tamper}><Wand2 className="size-3.5" /> Tamper with payload</Button>
        {payload !== manifest.payload && <Button size="sm" variant="ghost" onClick={() => setPayload(manifest.payload)}>Restore</Button>}
      </div>
    </div>
  );
}
