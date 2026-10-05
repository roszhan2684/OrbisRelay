import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import {
  ArrowRight,
  Ban,
  BellOff,
  Bot,
  Boxes,
  Building2,
  CheckCircle2,
  Code2,
  Factory,
  FileCheck2,
  Fingerprint,
  Gauge,
  GitBranch,
  HeartPulse,
  KeyRound,
  Lock,
  Mail,
  QrCode,
  Rocket,
  ScanSearch,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Wallet,
  Database,
  UserCheck,
  Eye,
  Gavel,
} from "lucide-react";
import { getDb } from "@/lib/server/store";
import { computeAnalytics } from "@/lib/server/analytics";
import { latestReceipt } from "@/lib/server/gateway";
import { Hero, HeroPhone } from "@/components/marketing/hero";
import { Playground } from "@/components/marketing/playground";
import { Film, LiveNumber, Nav, Reveal } from "@/components/marketing/parts";
import { ReceiptVerifier } from "@/components/receipt-verifier";
import { ProtectPanel } from "@/components/protect-panel";
import { Wordmark } from "@/components/logo";
import { Button } from "@/components/ui";
import urlCard from "@/lib/ml/cards/url.json";
import msgCard from "@/lib/ml/cards/message.json";

export const dynamic = "force-dynamic";

function Section({ id, eyebrow, title, lede, children, dark, className }: { id?: string; eyebrow: string; title: React.ReactNode; lede?: React.ReactNode; children: React.ReactNode; dark?: boolean; className?: string }) {
  return (
    <section id={id} className={`scroll-mt-16 ${dark ? "bg-night text-white" : ""} ${className ?? ""}`}>
      <div className="mx-auto max-w-[1240px] px-5 py-24 lg:py-32">
        <Reveal>
          <div className={`text-[12.5px] font-semibold uppercase tracking-[0.14em] ${dark ? "text-[#8fa2ff]" : "text-cobalt"}`}>{eyebrow}</div>
          <h2 className="mt-3 max-w-[820px] text-[36px] font-semibold leading-[1.06] tracking-[-0.035em] sm:text-[48px]">{title}</h2>
          {lede && <p className={`mt-5 max-w-[640px] text-[17px] leading-relaxed ${dark ? "text-white/60" : "text-muted"}`}>{lede}</p>}
        </Reveal>
        <div className="mt-14">{children}</div>
      </div>
    </section>
  );
}

const USE_CASES = [
  { icon: Bot, t: "AI agent tool calls", d: "Procurement agent sends confidential contracts to an unapproved model → paused, redirected to the private LLM." },
  { icon: Wallet, t: "Finance & payouts", d: "$84,000 to a vendor created two days ago with a fresh bank change → controller + Face ID." },
  { icon: Mail, t: "Customer support", d: "AI refund of $8,500 after an outage → manager edits to the contractual $8,160 and approves." },
  { icon: Rocket, t: "Production change", d: "Hotfix outside the change window during an incident → on-call sees diff, tests, rollback, blast radius." },
  { icon: KeyRound, t: "Privileged access", d: "30-minute DB admin → manager approval, step-up, auto-expiry and a receipt." },
  { icon: Database, t: "Data governance", d: "Bulk export of 120k customer records → blocked by default; exception needs data owner + security." },
  { icon: Building2, t: "Sales communications", d: "Agent emails non-public pricing → sales leader approves or auto-redacts restricted sections." },
  { icon: HeartPulse, t: "Regulated data", d: "Release of patient records to a partner → privacy officer, purpose and scope logged." },
  { icon: Factory, t: "Operations", d: "Maintenance AI recommends stopping a chiller line → site manager sees sensors and a reduced-load alternative." },
  { icon: QrCode, t: "Social engineering", d: "Employee scans a parking QR or forwards a “CEO” text → explainable verdict before anyone clicks or pays." },
  { icon: Snowflake, t: "Emergency response", d: "An agent's volume spikes 14× → one tap on iPhone freezes it; the gateway denies every next call." },
];

const TIERS = [
  { name: "Developer", price: "Free", note: "Proofs of concept", feats: ["1 tenant + sandbox", "3 integrations", "5k decisions / month", "Basic mobile approvals"] },
  { name: "Team", price: "$900", note: "per month · AI & platform teams", feats: ["Production gateway", "Policy Studio + simulator", "Audit trail & receipts", "50k decisions / month"] },
  { name: "Business", price: "$3,500", note: "per month · mid-market", feats: ["SSO, advanced routing & quorum", "Analytics & retention controls", "250k+ decisions", "Priority support"], featured: true },
  { name: "Enterprise", price: "Custom", note: "Regulated & large orgs", feats: ["SCIM, custom region & retention", "Private networking", "Audit export packages", "Dedicated limits & SLA"] },
];

export default async function Home() {
  const db = await getDb();
  const a = computeAnalytics(db, 28);
  const heroAction = [...db.actions].reverse().find((x) => x.final_status === "approved_modified" && x.safe_alternative_applied === "redirect_internal_model" && x.receipt_id);
  const receipt = heroAction?.receipt_id ? latestReceipt(db, heroAction.receipt_id, db.tenant.id) : undefined;
  const film = fs.existsSync(path.join(process.cwd(), "public/media/orbis-launch.mp4")) ? "/media/orbis-launch.mp4" : null;
  const poster = fs.existsSync(path.join(process.cwd(), "public/media/orbis-launch-poster.jpg")) ? "/media/orbis-launch-poster.jpg" : null;

  return (
    <div className="bg-page">
      <Nav />
      <Hero />

      {/* Problem */}
      <section className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-[1240px] gap-10 px-5 py-20 lg:grid-cols-[1fr_1.4fr] lg:py-24">
          <Reveal>
            <h2 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[40px]">Authentication proves who logged in. <span className="text-muted">It doesn't say whether <em className="font-serif font-normal">this</em> action is OK right now.</span></h2>
          </Reveal>
          <div className="grid gap-6 sm:grid-cols-3">
            {[
              { t: "Software now acts", d: "Agents send email, move money, deploy, export data and grant access — not just recommend." },
              { t: "Approvals are fragmented", d: "Every app builds its own approve button, so governance and audit fall apart across systems." },
              { t: "Block all or allow all", d: "Block everything and automation is useless. Allow everything and autonomy is dangerous." },
            ].map((x, i) => (
              <Reveal key={x.t} delay={i * 0.06}>
                <div className="border-t-2 border-ink pt-4">
                  <div className="text-[16px] font-semibold">{x.t}</div>
                  <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">{x.d}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <Section id="how" eyebrow="How it works" title={<>One question before every risky action: <span className="font-serif font-normal italic">may I do this?</span></>} lede="Orbis sits between software intent and execution. Safe work stays automatic; only genuinely ambiguous or high-impact actions reach a person.">
        <div className="grid gap-4 md:grid-cols-4">
          {[
            { n: "01", icon: Code2, t: "Propose", d: "Your app, agent or workflow calls preflight with actor, action, resources, destination and intent — redacted, never raw payloads." },
            { n: "02", icon: Gavel, t: "Decide", d: "Versioned, deterministic policy returns allow, warn, deny or approval_required in milliseconds. No LLM in the enforcement path." },
            { n: "03", icon: Fingerprint, t: "Escalate", d: "High-impact actions go to the right human's iPhone with evidence, blast radius and a safe alternative. Face ID when policy says so." },
            { n: "04", icon: FileCheck2, t: "Prove", d: "Your code executes only what was authorized, reports the outcome, and keeps an Ed25519-signed receipt anyone can verify." },
          ].map((s, i) => (
            <Reveal key={s.n} delay={i * 0.06}>
              <div className="relative h-full rounded-[18px] border border-line bg-surface p-5 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="grid size-10 place-items-center rounded-xl bg-cobalt-50 text-cobalt"><s.icon className="size-5" /></span>
                  <span className="font-mono text-[12px] text-faint">{s.n}</span>
                </div>
                <div className="mt-4 text-[17px] font-semibold">{s.t}</div>
                <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{s.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <div className="mt-6 grid gap-3 rounded-[18px] border border-line bg-surface p-5 font-mono text-[12.5px] shadow-card md:grid-cols-[1.2fr_1fr_1fr_1fr]">
            <div className="text-ink-2">orbis.preflight(action) →</div>
            <div className="flex items-center gap-2 text-low"><CheckCircle2 className="size-4" /> allow · execute now</div>
            <div className="flex items-center gap-2 text-cobalt"><Fingerprint className="size-4" /> approval_required · iPhone</div>
            <div className="flex items-center gap-2 text-critical"><Ban className="size-4" /> deny · never executes</div>
          </div>
        </Reveal>
      </Section>

      {/* Playground */}
      <Section id="playground" eyebrow="Try the engine" title="This is the real policy engine. Push it." lede="Change the action, the data class, the destination or the context and watch the same deterministic engine that runs the gateway decide — with the exact rule and risk factors behind every answer." className="bg-surface-2/60">
        <Playground />
      </Section>

      {/* iPhone */}
      <Section id="iphone" dark eyebrow="Orbis iOS" title={<>Not a tiny admin dashboard. <span className="text-white/50">A trusted decision terminal.</span></>} lede="Native SwiftUI. Understand any decision in five seconds — what, who, why, risk — then approve, edit, redirect or reject with Face ID.">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_auto]">
          <div className="grid gap-x-8 gap-y-7 sm:grid-cols-2">
            {[
              { icon: Gauge, t: "Five-second comprehension", d: "Action verb first, actor, intent, risk with reasons — evidence progressively disclosed." },
              { icon: Fingerprint, t: "Face ID step-up", d: "LocalAuthentication proves presence on a registered device. The server still verifies assignment, state and expiry." },
              { icon: Sparkles, t: "Safe alternatives", d: "Redirect to the private model, pay a $1 verification deposit, issue a service credit — not just yes or no." },
              { icon: Snowflake, t: "Emergency freeze", d: "Control tab freezes a misbehaving agent; every next gateway call is denied until an admin restores it." },
              { icon: BellOff, t: "Nothing sensitive in push", d: "Notifications carry a title and a deep link. High-risk approvals never complete from a notification." },
              { icon: ScanSearch, t: "Protect", d: "Share a link, scan a QR, or select a screenshot and get an explainable verdict before you click or pay." },
            ].map((f, i) => (
              <Reveal key={f.t} delay={i * 0.04}>
                <div className="flex gap-3.5">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-[#a9b7ff]"><f.icon className="size-5" /></span>
                  <div>
                    <div className="text-[16px] font-semibold">{f.t}</div>
                    <p className="mt-1 text-[14px] leading-relaxed text-white/55">{f.d}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal className="mx-auto">
            <HeroPhone />
            <p className="mt-4 text-center text-[12.5px] text-white/40">Interactive — tap “Redirect safely”.</p>
          </Reveal>
        </div>
        <Reveal className="mt-20">
          <div className="flex flex-wrap items-end justify-between gap-4 border-t border-white/10 pt-10">
            <div>
              <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[#8fa2ff]">The native app</div>
              <p className="mt-2 max-w-[520px] text-[15px] text-white/55">SwiftUI, Keychain, LocalAuthentication and deep links — running against the same live gateway as this site. Unedited simulator captures.</p>
            </div>
          </div>
          <div className="mt-8 grid grid-cols-3 gap-4 sm:gap-8">
            {[
              ["/media/ios-inbox.png", "Inbox — paused actions, highest risk first"],
              ["/media/ios-detail.png", "Decision — evidence, policy, safe alternative"],
              ["/media/ios-control.png", "Control — freeze a misbehaving agent"],
            ].map(([src, cap]) => (
              <figure key={src} className="text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={cap} loading="lazy" className="mx-auto w-full max-w-[300px] rounded-[28px] border border-white/10 shadow-[0_30px_80px_-30px_rgba(39,71,232,0.5)]" />
                <figcaption className="mt-3 text-[12.5px] text-white/50">{cap}</figcaption>
              </figure>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* Use cases */}
      <Section id="use-cases" eyebrow="Use cases" title="One reusable decision layer for every system that can act." lede="Build one generic integration, not fifteen bespoke approval screens. These all run in the Northstar Cloud demo tenant today.">
        <div className="grid gap-px overflow-hidden rounded-[22px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u, i) => (
            <Reveal key={u.t} delay={(i % 3) * 0.04} className="bg-surface">
              <div className="h-full p-6">
                <u.icon className="size-5 text-cobalt" />
                <div className="mt-3 text-[16px] font-semibold">{u.t}</div>
                <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{u.d}</p>
              </div>
            </Reveal>
          ))}
          <div className="bg-cobalt p-6 text-white">
            <Boxes className="size-5" />
            <div className="mt-3 text-[16px] font-semibold">Your system next</div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-white/75">Preflight API, Approval API or observe-only events — start with visibility, graduate to enforcement.</p>
            <Link href="/docs" className="mt-3 inline-flex items-center gap-1 text-[14px] font-semibold">Read the docs <ArrowRight className="size-4" /></Link>
          </div>
        </div>
      </Section>

      {/* Film */}
      <section id="film" className="scroll-mt-16 bg-night text-white">
        <div className="mx-auto max-w-[1100px] px-5 py-24 lg:py-28">
          <Reveal>
            <div className="text-center">
              <div className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-[#8fa2ff]">The launch film</div>
              <h2 className="mx-auto mt-3 max-w-[700px] text-[36px] font-semibold leading-[1.06] tracking-[-0.035em] sm:text-[44px]">Control without killing autonomy.</h2>
            </div>
          </Reveal>
          <Reveal className="mt-10"><Film src={film} poster={poster} /></Reveal>
        </div>
      </section>

      {/* Metrics */}
      <section className="border-b border-line bg-surface">
        <div className="mx-auto max-w-[1240px] px-5 py-20">
          <Reveal><div className="text-[13px] font-medium text-muted">Live from the Northstar Cloud demo tenant · last 28 days · computed from real decision events</div></Reveal>
          <div className="mt-6 grid grid-cols-2 gap-8 md:grid-cols-5">
            {[
              { v: a.totals.actions, l: "protected actions" },
              { v: a.autonomy_retained, s: "%", d: 1, l: "stayed autonomous" },
              { v: a.approval_latency.median_s, s: "s", l: "median human decision" },
              { v: a.impact.money_protected_usd, p: "$", c: true, d: 1, l: "held back by policy & people" },
              { v: a.safe_redirect_rate, s: "%", d: 1, l: "risky actions redirected, not just blocked" },
            ].map((m) => (
              <div key={m.l}>
                <div className="tnum text-[40px] font-semibold leading-none tracking-[-0.04em]"><LiveNumber value={m.v} suffix={m.s} prefix={m.p} decimals={m.d} compact={m.c} /></div>
                <div className="mt-2 text-[13.5px] text-muted">{m.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Developers */}
      <Section id="developers" eyebrow="Developers" title="Fifteen minutes to the first protected action." lede="TypeScript, Python and Swift SDKs. Typed envelopes, idempotent requests, webhook signatures, and an SDK that never executes your action for you.">
        <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
          <Reveal>
            <div className="overflow-hidden rounded-[22px] border border-line bg-night shadow-card">
              <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
                <span className="size-2.5 rounded-full bg-white/15" /><span className="size-2.5 rounded-full bg-white/15" /><span className="size-2.5 rounded-full bg-white/15" />
                <span className="ml-3 font-mono text-[12px] text-white/40">agent/tools.ts</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-[1.7] text-[#d7defa]">
                <code>{`const decision = await orbis.preflight({
  actor:       { type: "agent", id: "procurement-agent" },
  action:      { type: "external_send", tool: "llm.summarize" },
  resources:   [{ type: "document", classification: "confidential", count: 4 }],
  destination: { type: "external_model", value: "quickscribe-ai.app" },
  intent:      { reason: "Summarize vendor contracts for RFP" },
});

if (decision.isAllowed()) await execute();
else if (decision.requiresApproval()) {
  const final = await decision.waitForResolution({ timeoutMs: 600_000 });
  if (final.approved) await execute(final.approvedParameters);
}`}</code>
              </pre>
            </div>
          </Reveal>
          <div className="grid gap-3">
            {[
              { icon: GitBranch, t: "Three integration patterns", d: "Preflight before acting, explicit Approval API, or observe-only events to start with visibility." },
              { icon: Bot, t: "Agent adapter", d: "Wrap tool calls once; denials surface to the agent as errors it can reason about. Safe redirects re-plan automatically." },
              { icon: Lock, t: "Production patterns", d: "Idempotency keys, retries with backoff, HMAC-signed webhooks with replay windows, SSRF-safe callbacks." },
            ].map((x) => (
              <Reveal key={x.t}>
                <div className="flex gap-3.5 rounded-[18px] border border-line bg-surface p-5 shadow-card">
                  <x.icon className="mt-0.5 size-5 shrink-0 text-cobalt" />
                  <div><div className="text-[15px] font-semibold">{x.t}</div><p className="mt-1 text-[13.5px] leading-relaxed text-muted">{x.d}</p></div>
                </div>
              </Reveal>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="dark"><Link href="/docs">Quickstart <ArrowRight className="size-4" /></Link></Button>
              <Button asChild><a href="/api/v1/openapi" target="_blank">OpenAPI spec</a></Button>
            </div>
          </div>
        </div>
      </Section>

      {/* Receipts */}
      <Section eyebrow="Evidence" title={<>Audit logs say “approved.” <span className="text-muted">Receipts prove it.</span></>} lede="Every final decision produces a receipt bound to the exact policy version, evidence hash, approver, device step-up and downstream outcome — signed with Ed25519. Verify this real one from the demo tenant right here, then try tampering with it." className="bg-surface-2/60">
        <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-3">
            {[
              ["Who", "Actor, calling integration, approver identity, role and registered device"],
              ["What", "Envelope hash, normalized summary, original vs. approved parameters"],
              ["Why", "Policy ID + immutable version + deciding rule + risk features"],
              ["Proof", "SHA-256 body hash, Ed25519 signature, revision chain linking the outcome"],
            ].map(([k, v]) => (
              <Reveal key={k}>
                <div className="flex gap-4 rounded-[16px] border border-line bg-surface px-5 py-4 shadow-card">
                  <span className="w-14 shrink-0 text-[14px] font-semibold text-cobalt">{k}</span>
                  <span className="text-[14.5px] text-ink-2">{v}</span>
                </div>
              </Reveal>
            ))}
            <Link href="/verify" className="inline-flex items-center gap-1 pt-2 text-[14px] font-semibold text-cobalt hover:underline">Verify any receipt <ArrowRight className="size-4" /></Link>
          </div>
          {receipt ? <ReceiptVerifier receipt={{ id: receipt.id, body: receipt.body as unknown as Record<string, unknown>, body_hash: receipt.body_hash, signature: receipt.signature, key_id: receipt.key_id, alg: receipt.alg }} /> : <div />}
        </div>
      </Section>

      {/* Protect */}
      <Section eyebrow="Protect" title={<>“Is this safe?” — answered with evidence, <span className="text-muted">not vibes.</span></>} lede={`Two models trained from scratch on public datasets — a hostname phishing classifier (ROC-AUC ${urlCard.metrics.test.roc_auc.toFixed(2)}, ${urlCard.data.unique_hosts.toLocaleString()} hosts) and a scam-message classifier (F1 ${msgCard.metrics.test.f1.toFixed(2)}) — fused with explainable rules and your company's policy. Only content you explicitly share is analyzed.`}>
        <ProtectPanel endpoint="/api/public/protect" publicMode />
      </Section>

      {/* Security */}
      <Section id="security" dark eyebrow="Principles" title="Deterministic policy owns enforcement." lede="AI may summarize evidence, classify intent and recommend. It never silently overrides a hard deny, a threshold, a role requirement or a tenant control.">
        <div className="grid gap-px overflow-hidden rounded-[22px] border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: ShieldCheck, t: "Tenant isolation", d: "Tenant derives from the credential — never the payload. IDOR and cross-tenant tests in CI." },
            { icon: UserCheck, t: "Server is the authority", d: "Approvals verify assignment, state, expiry and step-up proof before any mutation." },
            { icon: Eye, t: "Metadata, not payloads", d: "Redacted summaries and classifications. No secrets or raw content in logs, traces or push." },
            { icon: KeyRound, t: "Keys & webhooks", d: "Keys hashed at rest and scoped. Webhooks HMAC-signed with timestamp replay protection." },
            { icon: FileCheck2, t: "Tamper-evident", d: "Hash-chained audit trail and signed receipts with revision chains." },
            { icon: Gavel, t: "Immutable policy", d: "Published versions never change. Drafts are simulated and co-signed by a second admin." },
            { icon: Snowflake, t: "Kill switch", d: "Freeze any actor instantly; pending approvals are cancelled and audited." },
            { icon: Lock, t: "Works without an LLM", d: "Core allow/deny/approval keeps working if every model provider is down." },
          ].map((x) => (
            <div key={x.t} className="bg-night p-6">
              <x.icon className="size-5 text-[#a9b7ff]" />
              <div className="mt-3 text-[15px] font-semibold">{x.t}</div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-white/55">{x.d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Pricing */}
      <Section id="pricing" eyebrow="Pricing" title="Priced on protected automation — never per approver." lede="Platform fee plus decision volume. Usage metering is computed after enforcement and can never change a decision.">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((t) => (
            <Reveal key={t.name}>
              <div className={`flex h-full flex-col rounded-[22px] border p-6 ${t.featured ? "border-cobalt bg-night text-white shadow-[0_30px_80px_-30px_rgba(39,71,232,0.6)]" : "border-line bg-surface shadow-card"}`}>
                <div className="text-[15px] font-semibold">{t.name}</div>
                <div className="mt-4 text-[38px] font-semibold tracking-[-0.03em]">{t.price}</div>
                <div className={`text-[13px] ${t.featured ? "text-white/55" : "text-muted"}`}>{t.note}</div>
                <ul className="mt-6 flex-1 space-y-2.5 text-[14px]">
                  {t.feats.map((f) => (
                    <li key={f} className="flex gap-2"><CheckCircle2 className={`mt-0.5 size-4 shrink-0 ${t.featured ? "text-[#8fa2ff]" : "text-cobalt"}`} /> {f}</li>
                  ))}
                </ul>
                <Button asChild variant={t.featured ? "primary" : "secondary"} className="mt-6"><Link href={t.name === "Enterprise" ? "/console" : "/demo"}>{t.name === "Enterprise" ? "Talk to us" : "Start with the demo"}</Link></Button>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* CTA */}
      <section className="relative overflow-hidden bg-night text-white">
        <div className="night-grid absolute inset-0 opacity-60" aria-hidden />
        <div className="relative mx-auto max-w-[1240px] px-5 py-24 text-center lg:py-32">
          <h2 className="mx-auto max-w-[820px] text-[40px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[60px]">
            Safe software stays autonomous. <span className="font-serif font-normal italic text-[#b9c4ff]">Risky</span> software asks first.
          </h2>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Button asChild variant="primary" size="lg"><Link href="/demo">Run the live demo <ArrowRight className="size-4" /></Link></Button>
            <Button asChild variant="outline-light" size="lg"><Link href="/console">Open the console</Link></Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 bg-night text-white/50">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-6 px-5 py-10 text-[13px]">
          <Wordmark light />
          <nav className="flex flex-wrap gap-5">
            <Link href="/docs" className="hover:text-white">Docs</Link>
            <Link href="/verify" className="hover:text-white">Verify a receipt</Link>
            <Link href="/console" className="hover:text-white">Console</Link>
            <Link href="/demo" className="hover:text-white">Demo app</Link>
            <a href="/api/v1/openapi" className="hover:text-white">OpenAPI</a>
          </nav>
          <p className="w-full text-[12px] text-white/30">Orbis Relay is a working product name for a portfolio-grade product. Northstar Cloud and all people in the demo are fictional.</p>
        </div>
      </footer>
    </div>
  );
}
