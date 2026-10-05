"use client";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertOctagon, CheckCircle2, ImageUp, Link2, Loader2, MessageSquareWarning, QrCode, ScanText, ShieldAlert, ShieldCheck, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import type { ProtectAnalysis } from "@/lib/domain";
import { Badge, Button, Card, Segmented, inputCls } from "@/components/ui";
import { Meter } from "@/components/charts";
import { cn } from "@/lib/format";

type Kind = "url" | "text" | "qr" | "screenshot";
const EXAMPLES: Record<Kind, string[]> = {
  url: ["https://northstar-payroll-update.com/login", "https://sso.northstar.cloud/device", "http://microsoft365-login.weeblysite.com/verify", "https://github.com/northstar-cloud/api-gateway"],
  text: ["Hi, it's Priya. I'm in a meeting and can't talk — please buy 5 Apple gift cards for a client today and keep this between us.", "Vendor update: we changed our bank details, please wire the March invoice to the new account ASAP.", "Reminder: design review moved to 3pm Thursday."],
  qr: ["https://bit.ly/ns-parking-pay"],
  screenshot: ["Your Northstar SSO password expires today. Verify now at https://northstar-sso-reset.com/login to keep access."],
};

export function ProtectPanel({ endpoint = "/api/v1/protect/analyze", onResult, publicMode }: { endpoint?: string; onResult?: (a: ProtectAnalysis) => void; publicMode?: boolean }) {
  const [kind, setKind] = React.useState<Kind>("url");
  const [input, setInput] = React.useState(EXAMPLES.url[0]);
  const [busy, setBusy] = React.useState(false);
  const [res, setRes] = React.useState<ProtectAnalysis | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const analyze = async (k = kind, i = input) => {
    if (!i.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: k, input: i }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message ?? "Analysis failed");
      setRes(data);
      onResult?.(data);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decodeQr = async (file: File) => {
    const { default: jsQR } = await import("jsqr");
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const code = jsQR(img.data, img.width, img.height);
    if (!code) return toast.error("No QR code found in that image.");
    setInput(code.data);
    toast.success("QR decoded locally — the destination is checked before you open it");
    void analyze("qr", code.data);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
      <Card className="p-5">
        <Segmented
          value={kind}
          onChange={(k) => {
            setKind(k);
            setInput(EXAMPLES[k][0]);
            setRes(null);
          }}
          options={[
            { value: "url", label: <span className="flex items-center gap-1.5"><Link2 className="size-3.5" /> Link</span> },
            { value: "text", label: <span className="flex items-center gap-1.5"><MessageSquareWarning className="size-3.5" /> Message</span> },
            { value: "qr", label: <span className="flex items-center gap-1.5"><QrCode className="size-3.5" /> QR</span> },
            { value: "screenshot", label: <span className="flex items-center gap-1.5"><ScanText className="size-3.5" /> Screenshot text</span> },
          ]}
        />
        <div className="mt-4">
          {kind === "url" || kind === "qr" ? (
            <input value={input} onChange={(e) => setInput(e.target.value)} className={cn(inputCls, "font-mono text-[13px]")} placeholder="Paste a link…" aria-label="Link to check" />
          ) : (
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={5} className={cn(inputCls, "h-auto py-2.5")} placeholder="Paste the message or the text extracted from a screenshot…" aria-label="Message to check" />
          )}
        </div>
        {kind === "qr" && (
          <>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && decodeQr(e.target.files[0])} />
            <button onClick={() => fileRef.current?.click()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-4 text-[13px] text-ink-2 hover:border-cobalt hover:text-cobalt">
              <ImageUp className="size-4" /> Upload a photo of a QR code — decoded in your browser
            </button>
          </>
        )}
        {kind === "screenshot" && <p className="mt-2 text-[12px] text-muted">On iPhone, Orbis extracts visible text on-device with Vision before anything is sent. Only text you explicitly share is analyzed.</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES[kind].map((e) => (
            <button key={e} onClick={() => (setInput(e), void analyze(kind, e))} className="max-w-full truncate rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2 ring-1 ring-inset ring-line hover:ring-cobalt/40">
              {e.length > 54 ? e.slice(0, 54) + "…" : e}
            </button>
          ))}
        </div>
        <Button variant="primary" className="mt-4 w-full" onClick={() => analyze()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Is this safe?
        </Button>
        <p className="mt-3 text-[11.5px] leading-snug text-faint">
          {publicMode ? "Runs the same from-scratch models used in the Orbis iOS app. Nothing you paste here is stored." : "Never auto-enforced. Scores feed an explanation and a recommendation; your organization's policy stays deterministic."}
        </p>
      </Card>

      <AnimatePresence mode="wait">
        {res ? <ResultCard key={res.id ?? res.created_at} a={res} /> : (
          <Card className="grid place-items-center p-8 text-center">
            <div>
              <ShieldCheck className="mx-auto size-9 text-cobalt" strokeWidth={1.5} />
              <p className="mt-3 text-[15px] font-semibold">Check before you click, pay or reply</p>
              <p className="mt-1 max-w-sm text-[13px] text-muted">A recommendation with evidence and Northstar policy — not a generic chatbot answer.</p>
            </div>
          </Card>
        )}
      </AnimatePresence>
    </div>
  );
}

export function ResultCard({ a }: { a: ProtectAnalysis }) {
  const meta = {
    dangerous: { icon: AlertOctagon, label: "Dangerous", cls: "bg-critical-bg text-critical", tone: "critical" as const },
    caution: { icon: ShieldAlert, label: "Be careful", cls: "bg-medium-bg text-medium", tone: "high" as const },
    safe: { icon: CheckCircle2, label: "Looks safe", cls: "bg-low-bg text-low", tone: "low" as const },
  }[a.verdict];
  const Icon = meta.icon;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <Card className="overflow-hidden">
        <div className={cn("flex items-center gap-3 px-5 py-4", meta.cls)}>
          <Icon className="size-7" />
          <div className="flex-1">
            <div className="text-[18px] font-semibold">{meta.label}</div>
            <div className="text-[12.5px] opacity-80">Risk score {a.score}/100</div>
          </div>
          <div className="w-28"><Meter value={a.score} tone={meta.tone} /></div>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-[14.5px] font-medium text-ink">{a.recommendation}</p>
          {a.policy_note && <div className="rounded-xl bg-cobalt-50 px-3.5 py-2.5 text-[13px] text-cobalt-700">{a.policy_note}</div>}
          <ul className="space-y-2">
            {a.reasons.map((r, i) => (
              <li key={i} className="flex gap-2.5 text-[13.5px]">
                {r.weight === "positive" ? <ThumbsUp className="mt-0.5 size-4 shrink-0 text-low" /> : <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", r.weight === "high" ? "bg-critical" : r.weight === "medium" ? "bg-high" : "bg-faint")} />}
                <span><span className="font-medium">{r.label}.</span> <span className="text-ink-2">{r.detail}</span></span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 border-t border-line pt-3 text-[11.5px] text-muted">
            {a.model.map((m) => <Badge key={m.name} tone="neutral" className="font-mono text-[11px]">{m.name}@{m.version} · p={m.probability.toFixed(3)}</Badge>)}
            <span className="truncate">Input: {a.input_preview}</span>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
