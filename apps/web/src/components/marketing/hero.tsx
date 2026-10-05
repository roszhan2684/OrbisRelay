"use client";
import Link from "next/link";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Ban, Bot, CheckCircle2, Hourglass, Play, TriangleAlert, User, Workflow, Zap } from "lucide-react";
import { PhoneApprovalDetail, PhoneFrame, type PhoneApproval } from "@/components/phone";
import { canonicalize } from "@/lib/canonical";
import { Button } from "@/components/ui";
import { cn } from "@/lib/format";
import { runEngine, STREAM } from "./engine";

const KIND_ICON = { agent: Bot, workflow: Workflow, automation: Zap, human: User } as const;
const STATUS = {
  allow: { label: "Allowed", icon: CheckCircle2, cls: "text-[#3dd68c] bg-[#3dd68c]/10 ring-[#3dd68c]/20" },
  warn: { label: "Allowed · warned", icon: TriangleAlert, cls: "text-[#ffb224] bg-[#ffb224]/10 ring-[#ffb224]/20" },
  approval_required: { label: "Paused for human", icon: Hourglass, cls: "text-[#8fa2ff] bg-[#4f6bff]/15 ring-[#4f6bff]/30" },
  deny: { label: "Denied", icon: Ban, cls: "text-[#ff6369] bg-[#ff6369]/10 ring-[#ff6369]/20" },
} as const;

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-night text-white">
      <div className="night-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]" aria-hidden />
      <div className="absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[#2747e8]/20 blur-[120px]" aria-hidden />
      <div className="relative mx-auto grid max-w-[1240px] gap-12 px-5 pb-20 pt-32 lg:grid-cols-[0.92fr_1.08fr] lg:gap-10 lg:pb-28 lg:pt-40">
        <div className="flex flex-col justify-center">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="inline-flex w-fit items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 text-[12.5px] text-white/70">
            <span className="size-1.5 rounded-full bg-[#3dd68c]" /> Human trust infrastructure for autonomous software
          </motion.div>
          <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mt-6 text-balance text-[40px] font-semibold leading-[1.03] tracking-[-0.04em] sm:text-[54px] lg:text-[46px] xl:text-[56px] 2xl:text-[62px]">
            Let software act. Keep a <span className="font-serif font-normal italic tracking-[-0.01em] text-[#b9c4ff]">human</span> on the decisions that matter.
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-6 max-w-[540px] text-[17px] leading-relaxed text-white/65">
            Before an AI agent, workflow or internal tool does something risky, it asks Orbis. Deterministic policy decides in milliseconds; high-impact actions go to a verified human on iPhone; every decision comes back with a signed receipt.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="mt-8 flex flex-wrap gap-3">
            <Button asChild variant="primary" size="lg">
              <Link href="/demo">Run the live demo <ArrowRight className="size-4" /></Link>
            </Button>
            <Button asChild variant="outline-light" size="lg">
              <a href="#film"><Play className="size-4" /> Watch the film</a>
            </Button>
          </motion.div>
          <div className="mt-10 grid max-w-[520px] grid-cols-3 gap-6 border-t border-white/10 pt-6 text-[13px] text-white/55">
            <div><div className="tnum text-[22px] font-semibold text-white">&lt;20ms</div>policy decision</div>
            <div><div className="tnum text-[22px] font-semibold text-white">90%</div>stays autonomous</div>
            <div><div className="tnum text-[22px] font-semibold text-white">0</div>LLM calls to enforce</div>
          </div>
        </div>
        <RelayVisual />
      </div>
    </section>
  );
}

function RelayVisual() {
  const [items, setItems] = React.useState<Array<{ key: number; i: number; r: ReturnType<typeof runEngine> }>>([]);
  const n = React.useRef(0);
  React.useEffect(() => {
    const push = () => {
      const key = n.current++;
      const i = key % STREAM.length;
      const r = runEngine({ ...STREAM[i].env, request_id: `r${key}` });
      setItems((xs) => [{ key, i, r }, ...xs].slice(0, 6));
    };
    for (let k = 0; k < 4; k++) push();
    const t = setInterval(push, 1900);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative">
      <div className="rounded-[22px] border border-white/10 bg-white/[0.035] p-4 shadow-[0_40px_120px_-40px_rgba(39,71,232,0.45)] backdrop-blur-sm xl:mr-40">
        <div className="mb-3 flex items-center justify-between px-1 text-[12px] text-white/50">
          <span className="flex items-center gap-2"><span className="size-1.5 animate-pulse rounded-full bg-[#3dd68c]" /> Orbis gateway · live</span>
          <span className="font-mono">POST /v1/decisions/preflight</span>
        </div>
        <ul className="relative h-[372px] space-y-2 overflow-hidden">
          <AnimatePresence initial={false}>
            {items.map(({ key, i, r }) => {
              const s = STREAM[i];
              const st = STATUS[r.status];
              const Icon = KIND_ICON[s.kind];
              const SIcon = st.icon;
              return (
                <motion.li key={key} layout initial={{ opacity: 0, y: -14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 300, damping: 30 }} className="flex items-center gap-3 rounded-xl border border-white/8 bg-[#0d1326]/80 px-3.5 py-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-white/70"><Icon className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-white/90">{s.title}</span>
                    <span className="block truncate text-[11.5px] text-white/40">{s.actor} · {r.deciding ? r.deciding.rule_name : "no rule matched"}</span>
                  </span>
                  <span className={cn("flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1 ring-inset", st.cls)}>
                    <SIcon className="size-3.5" /> {st.label}
                  </span>
                </motion.li>
              );
            })}
          </AnimatePresence>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0b1022] to-transparent" />
        </ul>
        <p className="mt-2 px-1 text-[11.5px] text-white/35">This is the production policy engine running in your browser on the default Northstar policy pack.</p>
      </div>
      <div className="absolute -bottom-20 -right-4 hidden origin-bottom-right scale-[0.56] xl:block">
        <HeroPhone />
      </div>
    </div>
  );
}

const HERO_ENV = STREAM[2].env;
export function heroApproval(): PhoneApproval {
  const r = runEngine({ ...HERO_ENV, request_id: "hero" });
  return {
    id: "apr_hero",
    title: "Send 4 contracts to external AI",
    summary: "4 confidential vendor contracts",
    intent: "Summarize four vendor contracts for the Q4 RFP response",
    route: r.approval?.route ?? "ai-governance",
    status: "pending",
    step_up: "biometric",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 14 * 60_000).toISOString(),
    editable_fields: [],
    safe_alternatives: r.safe_alternatives,
    evidence: [
      { id: "e1", label: "Documents", value: "MSA + 3 SOWs · pricing & liability terms", source: "Procurement Agent" },
      { id: "e2", label: "Destination", value: "quickscribe-ai.app — not on AI allowlist, 30-day retention", source: "Orbis registry" },
      { id: "e3", label: "Agent history", value: "212 tool calls · 0 prior external sends", source: "Orbis baseline" },
    ],
    blast_radius: ["4 confidential contracts leave the trust boundary", "Deal D-82 negotiating position exposed"],
    risk: r.risk,
    policy: { id: r.deciding!.policy_id, name: r.deciding!.policy_name, version: r.deciding!.version, rule_id: r.deciding!.rule_id, rule_name: r.deciding!.rule_name, reason: r.deciding!.reason },
    actor: { id: "procurement-agent", type: "agent", name: "Procurement Agent" },
    integration: { id: "int_procurement", name: "Procurement Agent" },
    parameters: {},
    escalation_level: 0,
    can_respond: true,
  };
}

export function HeroPhone() {
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const a = React.useMemo(() => (mounted ? heroApproval() : null), [mounted]);
  const [result, setResult] = React.useState<{ status: string; receipt_id?: string | null; message?: string } | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!a) return <PhoneFrame><div /></PhoneFrame>;
  return (
    <PhoneFrame>
      <PhoneApprovalDetail
        a={a}
        now={now}
        result={result}
        onRespond={async (p) => {
          const body = { decision: p.decision, approval: a.id, policy: a.policy, at: new Date().toISOString() };
          const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(body)));
          const hex = [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
          setResult({ status: "done", receipt_id: `sha256:${hex.slice(0, 16)}…`, message: p.decision === "safe_alternative" ? "Redirected safely — agent continues on the private model" : p.decision === "reject" ? "Rejected — nothing executed" : "Approved" });
          setTimeout(() => setResult(null), 4200);
        }}
      />
    </PhoneFrame>
  );
}
