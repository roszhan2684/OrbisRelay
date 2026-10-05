"use client";
import Link from "next/link";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Bot, CheckCircle2, CircleDashed, FileCheck2, Loader2, Play, RotateCcw, Rocket, Snowflake, Sun, Wallet, XCircle, Zap, LogIn, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { PhoneApprovalDetail, PhoneFrame, type PhoneApproval, type ResponsePayload } from "@/components/phone";
import { Badge, Button, RiskBadge } from "@/components/ui";
import { cn } from "@/lib/format";

type Scenario = "hero" | "refund" | "deploy" | "ops";
type Line = { id: number; t: string; kind: "agent" | "orbis" | "wait" | "ok" | "bad" | "info"; text: string; sub?: string };

const SCENARIOS: Array<{ key: Scenario; title: string; who: string; icon: React.ComponentType<{ className?: string }>; blurb: string }> = [
  { key: "hero", title: "AI agent → external model", who: "Procurement Agent", icon: Bot, blurb: "Agent tries to send 4 confidential contracts to an unapproved AI provider." },
  { key: "refund", title: "Refund after outage", who: "Support Copilot", icon: Wallet, blurb: "AI wants to refund $8,500 — above the autonomous threshold." },
  { key: "deploy", title: "Production deploy during incident", who: "CI Deployer", icon: Rocket, blurb: "Hotfix outside the change window while INC-2304 is open." },
  { key: "ops", title: "Emergency freeze drill", who: "Ops Agent", icon: Zap, blurb: "Agent volume spikes. Freeze it — the gateway denies every next call." },
];

const STEPS: Record<Scenario, string[]> = {
  hero: ["Task: summarize 4 vendor contracts for the Q4 RFP", "Plan: call llm.summarize on quickscribe-ai.app (fastest model)"],
  refund: ["Ticket ZD-55410: Tailspin Toys requests outage credit", "Plan: billing.refund $8,500"],
  deploy: ["INC-2304 open: invoice rounding regression", "Plan: deploy.promote billing-service v3.12.1 → production"],
  ops: ["Alert storm: staging pool saturation", "Plan: rotate config repeatedly until saturation clears"],
};

export function DemoApp({ signedIn }: { signedIn: boolean }) {
  const [sc, setSc] = React.useState<Scenario>("hero");
  const [lines, setLines] = React.useState<Line[]>([]);
  const [running, setRunning] = React.useState(false);
  const [approval, setApproval] = React.useState<PhoneApproval | null>(null);
  const [authed, setAuthed] = React.useState(signedIn);
  const [phoneResult, setPhoneResult] = React.useState<{ status: string; receipt_id?: string | null; message?: string } | null>(null);
  const [receipt, setReceipt] = React.useState<string | null>(null);
  const [frozen, setFrozen] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const seq = React.useRef(0);
  const cancel = React.useRef(false);

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const log = (kind: Line["kind"], text: string, sub?: string) => setLines((l) => [...l, { id: ++seq.current, t: new Date().toLocaleTimeString("en-US", { hour12: false }), kind, text, sub }]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const reset = () => {
    cancel.current = true;
    setLines([]);
    setApproval(null);
    setReceipt(null);
    setPhoneResult(null);
    setRunning(false);
  };

  const signIn = async () => {
    await fetch("/api/auth/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "alex.chen@northstar.cloud" }) });
    setAuthed(true);
    toast.success("Signed in as Alex Chen (approver)");
  };

  const runOnce = async (scenario: Scenario, quiet = false) => {
    const r = await fetch("/api/demo-customer/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message ?? "Gateway error");
    if (!quiet) return data.decision;
    return data.decision;
  };

  const run = async () => {
    reset();
    cancel.current = false;
    setRunning(true);
    try {
      for (const s of STEPS[sc]) {
        log("agent", s);
        await sleep(650);
      }
      if (sc === "ops") return await runOps();
      log("info", "orbis.preflight(...)", "SDK call from Northstar's backend — before the tool executes");
      const d = await runOnce(sc);
      log(d.status === "approval_required" ? "wait" : d.status === "deny" ? "bad" : "ok", `Orbis → ${d.status.replace("_", " ")}  ·  risk ${d.risk.score} ${d.risk.level}  ·  ${d.latency_ms}ms`, d.policy ? `${d.policy.name} v${d.policy.version}: ${d.policy.reason}` : "No rule matched");
      if (d.status === "deny") return log("bad", "Agent stops. Nothing executed.", d.frozen ? "Actor is frozen" : undefined);
      if (d.status === "allow" || d.status === "warn") return await execute(d.action_id, null);
      log("wait", "Action paused — sent to a verified human on iPhone", `${d.approval.route} · step-up: ${d.approval.step_up} · expires ${new Date(d.approval.expires_at).toLocaleTimeString()}`);
      if (d.safe_alternatives?.length) log("info", `Safe alternative offered: ${d.safe_alternatives[0].label}`);
      // show approval on the embedded approver phone
      await loadApproval(d.approval.id);
      // poll like decision.waitForResolution()
      for (;;) {
        if (cancel.current) return;
        await sleep(1500);
        const st = await fetch(`/api/demo-customer/status?scenario=${sc}&approval=${d.approval.id}`).then((x) => x.json());
        if (st.status && st.status !== "pending") {
          const ok = st.status === "approved" || st.status === "approved_modified";
          log(ok ? "ok" : "bad", `Human decision: ${st.status.replace("_", " ")}`, st.approved_parameters ? `approved parameters → ${JSON.stringify(st.approved_parameters)}` : undefined);
          if (!ok) {
            log("bad", "Agent respects the decision. Nothing executed.");
            setReceipt(st.receipt_id);
            return;
          }
          if (sc === "hero" && st.approved_parameters?.destination === "northstar-private-llm") log("agent", "Re-planning: running the same task on northstar-private-llm");
          return await execute(d.action_id, st.approved_parameters);
        }
      }
    } catch (e) {
      log("bad", (e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const execute = async (actionId: string, params: Record<string, unknown> | null) => {
    log("agent", "Executing…");
    const r = await fetch("/api/demo-customer/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: sc, action_id: actionId, approved_parameters: params }) }).then((x) => x.json());
    log("ok", r.detail, `Outcome reported · receipt ${r.receipt_id} (rev 2, Ed25519)`);
    setReceipt(r.receipt_id);
  };

  const runOps = async () => {
    log("info", "Agent enters a tight loop — 1 call every 700ms");
    for (let i = 1; i <= 40; i++) {
      if (cancel.current) return;
      const d = await runOnce("ops", true);
      log(d.status === "deny" ? "bad" : d.status === "warn" ? "wait" : "ok", `#${i} config.write → ${d.status}${d.frozen ? " · FROZEN" : ""}`, d.status === "warn" ? "Anomaly: 14-day baseline exceeded — security notified" : d.frozen ? "Gateway rejects every request until an admin restores the agent" : undefined);
      if (d.frozen) {
        setFrozen(true);
        if (i > 3) {
          log("info", "Agent halted by Orbis. Restore it from Control on iPhone or Agents & Actors in the console.");
          return;
        }
      }
      await sleep(700);
    }
  };

  const loadApproval = async (id: string) => {
    if (!authed) return setApproval({ id } as PhoneApproval);
    const r = await fetch(`/api/v1/approvals/${id}`);
    if (r.ok) setApproval(await r.json());
  };
  React.useEffect(() => {
    if (authed && approval && !approval.title) void loadApproval(approval.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  const respond = async (p: ResponsePayload) => {
    if (!approval) return;
    const r = await fetch(`/api/v1/approvals/${approval.id}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...p, step_up: p.decision === "reject" ? undefined : { method: "passkey", verified: true } }) });
    const data = await r.json();
    if (!r.ok) {
      toast.error(data.error?.message);
      return;
    }
    setPhoneResult({ status: data.status, receipt_id: data.receipt_id, message: data.status === "pending" ? "Signed — waiting for quorum" : p.decision === "safe_alternative" ? "Redirected safely" : data.status === "rejected" ? "Rejected" : "Approved" });
  };

  const freeze = async (on: boolean) => {
    if (!authed) await signIn();
    const r = await fetch(`/api/v1/actors/ops-agent/freeze`, { method: on ? "POST" : "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: on ? "Runaway config loop during freeze drill" : "Loop fixed; rate limit added to agent" }) });
    if (!r.ok) return toast.error((await r.json()).error?.message);
    setFrozen(on);
    toast.success(on ? "Ops Agent frozen — next gateway call will be denied" : "Ops Agent restored");
  };

  const meta = SCENARIOS.find((s) => s.key === sc)!;
  return (
    <div className="min-h-screen bg-[#0b0d12] text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-amber-300 to-orange-500 text-[15px] font-black text-black">N</span>
          <div className="leading-tight">
            <div className="text-[14px] font-semibold">Northstar Cloud · Ops Console</div>
            <div className="text-[11.5px] text-white/50">Fictional customer app protected by Orbis Relay</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/console" className="hidden items-center gap-1 rounded-lg px-3 py-1.5 text-[13px] text-white/70 hover:bg-white/10 hover:text-white sm:flex">Orbis console <ArrowUpRight className="size-3.5" /></Link>
          <Link href="/" className="rounded-lg px-3 py-1.5 text-[13px] text-white/70 hover:bg-white/10 hover:text-white">orbisrelay.dev</Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-5 px-4 py-6 lg:grid-cols-[300px_1fr_380px] lg:px-6">
        <aside className="space-y-2">
          <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">Scenarios</div>
          {SCENARIOS.map((s) => (
            <button key={s.key} onClick={() => (setSc(s.key), reset())} className={cn("w-full rounded-xl border px-3.5 py-3 text-left transition", sc === s.key ? "border-[#4f6bff] bg-[#4f6bff]/10" : "border-white/10 bg-white/[0.03] hover:border-white/25")}>
              <div className="flex items-center gap-2 text-[14px] font-semibold"><s.icon className="size-4 text-[#8fa2ff]" /> {s.title}</div>
              <div className="mt-1 text-[12.5px] leading-snug text-white/55">{s.blurb}</div>
            </button>
          ))}
          <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3.5 text-[12.5px] leading-relaxed text-white/60">
            Northstar's backend holds the API key and calls <code className="text-[#a9b7ff]">orbis.preflight()</code> before each risky tool call. The agent only acts on Orbis's answer.
          </div>
        </aside>

        <main className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[12px] text-white/50">{meta.who}</div>
              <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{meta.title}</h1>
            </div>
            <div className="flex gap-2">
              {sc === "ops" && (frozen ? (
                <Button variant="outline-light" size="sm" onClick={() => freeze(false)}><Sun className="size-4" /> Restore agent</Button>
              ) : (
                <Button size="sm" className="bg-[#e5484d] text-white hover:bg-[#cc3c41]" onClick={() => freeze(true)}><Snowflake className="size-4" /> Freeze Ops Agent</Button>
              ))}
              <Button variant="outline-light" size="sm" onClick={reset}><RotateCcw className="size-4" /> Reset</Button>
              <Button variant="primary" size="sm" onClick={run} disabled={running}>{running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run agent</Button>
            </div>
          </div>

          <div className="mt-4 min-h-[520px] rounded-2xl border border-white/10 bg-[#07080c] p-4 font-mono text-[12.5px]">
            {lines.length === 0 && <div className="grid h-[480px] place-items-center text-center font-sans text-[14px] text-white/40">Press <span className="mx-1 rounded bg-white/10 px-1.5 py-0.5 text-white/80">Run agent</span> to watch Northstar's automation ask Orbis before it acts.</div>}
            <AnimatePresence initial={false}>
              {lines.map((l) => (
                <motion.div key={l.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3 py-1">
                  <span className="shrink-0 text-white/30">{l.t}</span>
                  <span className="mt-[3px] shrink-0">
                    {l.kind === "ok" ? <CheckCircle2 className="size-3.5 text-[#3dd68c]" /> : l.kind === "bad" ? <XCircle className="size-3.5 text-[#ff6369]" /> : l.kind === "wait" ? <CircleDashed className="size-3.5 animate-spin text-[#ffb224] [animation-duration:3s]" /> : l.kind === "agent" ? <Bot className="size-3.5 text-white/50" /> : <span className="block size-3.5 text-center text-[#8fa2ff]">›</span>}
                  </span>
                  <span className="min-w-0">
                    <span className={cn(l.kind === "ok" && "text-[#3dd68c]", l.kind === "bad" && "text-[#ff6369]", l.kind === "wait" && "text-[#ffb224]", l.kind === "info" && "text-[#a9b7ff]", l.kind === "agent" && "text-white/80")}>{l.text}</span>
                    {l.sub && <span className="block text-[11.5px] text-white/40">{l.sub}</span>}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
            {receipt && (
              <Link href={`/console/receipts/${receipt}`} className="mt-4 flex items-center justify-between rounded-xl border border-[#3dd68c]/30 bg-[#3dd68c]/10 px-4 py-3 font-sans text-[13.5px] text-[#3dd68c] hover:bg-[#3dd68c]/15">
                <span className="flex items-center gap-2"><FileCheck2 className="size-4" /> Signed decision receipt {receipt}</span>
                <span className="flex items-center gap-1">Verify <ArrowUpRight className="size-4" /></span>
              </Link>
            )}
          </div>
        </main>

        <aside>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40"><Smartphone className="size-3.5" /> Approver's iPhone</span>
            {approval?.risk && <RiskBadge level={approval.risk.level} score={approval.risk.score} />}
          </div>
          <PhoneFrame className="scale-[0.94] origin-top">
            {!approval ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center text-[#6b7280]">
                <Smartphone className="size-10" strokeWidth={1.3} />
                <p className="mt-3 text-[15px] font-medium text-ink">Waiting for paused actions</p>
                <p className="mt-1 text-[13px]">When Orbis pauses an action, the approval lands here — and on every assigned approver's Orbis iOS app.</p>
              </div>
            ) : !authed || !approval.title ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <Badge tone="cobalt">Action paused</Badge>
                <p className="mt-3 text-[15px] font-semibold text-ink">Sign in as an approver to decide</p>
                <p className="mt-1 text-[13px] text-[#6b7280]">Demo SSO signs you in as Alex Chen, Head of Platform Trust.</p>
                <Button variant="primary" className="mt-4" onClick={async () => { await signIn(); }}><LogIn className="size-4" /> Sign in as approver</Button>
              </div>
            ) : (
              <PhoneApprovalDetail a={approval} now={now} onRespond={respond} result={phoneResult} />
            )}
          </PhoneFrame>
        </aside>
      </div>
    </div>
  );
}
