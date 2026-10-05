"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Bot, CheckCircle2, ChevronDown, Clock3, Fingerprint, Inbox, KeyRound, Loader2, Pencil, Shield, Sparkles, Users, X } from "lucide-react";
import { toast } from "sonner";
import type { ApprovalRecord } from "@/lib/domain";
import { api, useLive, useNow } from "@/components/console/live";
import { Countdown, RelTime } from "@/components/console/time";
import { TrustTimeline } from "@/components/console/action-inspector";
import { Avatar, Badge, Button, Card, EmptyState, Mono, RiskBadge, Segmented, StatusBadge, inputCls } from "@/components/ui";
import { Meter } from "@/components/charts";
import { cn, ROUTE_LABEL } from "@/lib/format";

type A = ApprovalRecord & {
  can_respond: boolean;
  final_status?: string;
  receipt_id: string | null;
  quorum_progress: { approvals: number; required: number; of: number } | null;
  my_response: unknown;
};
type Tab = "mine" | "pending" | "escalated" | "resolved";

export function ApprovalsBoard({ initial, users }: { initial: A[]; users: Record<string, { name: string; color: string; title: string }> }) {
  const sp = useSearchParams();
  const router = useRouter();
  const [items, setItems] = React.useState<A[]>(initial);
  const [tab, setTab] = React.useState<Tab>("mine");
  const [sel, setSel] = React.useState<string | null>(sp.get("id"));
  const { subscribe } = useLive();
  const now = useNow();

  const reload = React.useCallback(async () => {
    const res = await api<{ data: A[] }>("/api/v1/approvals?scope=all&limit=200");
    setItems(res.data);
  }, []);
  React.useEffect(() => subscribe((e) => e.type.startsWith("approval.") || e.type === "demo.reset" || e.type === "freeze.changed" ? void reload() : undefined), [subscribe, reload]);

  const lists: Record<Tab, A[]> = {
    mine: items.filter((a) => a.status === "pending" && a.can_respond),
    pending: items.filter((a) => a.status === "pending"),
    escalated: items.filter((a) => a.status === "pending" && a.escalation_level > 0),
    resolved: items.filter((a) => a.status !== "pending"),
  };
  const list = lists[tab];
  const current = items.find((a) => a.id === sel) ?? list[0];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={tab}
          onChange={(t) => {
            setTab(t);
            setSel(null);
          }}
          options={[
            { value: "mine", label: <>Needs me <span className="tnum opacity-60">{lists.mine.length}</span></> },
            { value: "pending", label: <>All pending <span className="tnum opacity-60">{lists.pending.length}</span></> },
            { value: "escalated", label: <>Escalated <span className="tnum opacity-60">{lists.escalated.length}</span></> },
            { value: "resolved", label: <>Resolved <span className="tnum opacity-60">{lists.resolved.length}</span></> },
          ]}
        />
        <p className="text-[12.5px] text-muted">Approvals route by resource owner and role · SLA escalates at 50% of TTL · quorum for extreme actions</p>
      </div>
      {list.length === 0 ? (
        <Card>
          <EmptyState icon={Inbox} title={tab === "mine" ? "You're all caught up" : "Nothing here"} body="Safe work keeps running autonomously. Trigger a scenario in the Northstar demo app to see an action pause for approval." action={<Button asChild variant="primary" size="sm"><Link href="/demo">Open demo app</Link></Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
          <Card className="max-h-[calc(100vh-13rem)] overflow-y-auto">
            <ul className="divide-y divide-line">
              {list.map((a) => (
                <li key={a.id}>
                  <button onClick={() => (setSel(a.id), router.replace(`/console/approvals?id=${a.id}`, { scroll: false }))} className={cn("w-full px-4 py-3 text-left transition", current?.id === a.id ? "bg-cobalt-50/70 shadow-[inset_3px_0_0_var(--color-cobalt)]" : "hover:bg-surface-2/60")}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[14px] font-semibold leading-snug">{a.title}</span>
                      <RiskBadge level={a.risk.level} />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[12px] text-muted">
                      <span className="truncate">{a.actor.name} · {ROUTE_LABEL[a.route] ?? a.route}</span>
                      {a.status === "pending" ? <Countdown to={a.expires_at} /> : <StatusBadge status={a.status} />}
                    </div>
                    {a.escalation_level > 0 && a.status === "pending" && <Badge tone="high" className="mt-1.5">Escalated</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {current && <DecisionPanel key={current.id} a={current} users={users} now={now} onDone={reload} />}
        </div>
      )}
    </div>
  );
}

function DecisionPanel({ a, users, now, onDone }: { a: A; users: Record<string, { name: string; color: string; title: string }>; now: number; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [edit, setEdit] = React.useState(false);
  const [vals, setVals] = React.useState<Record<string, number>>({});
  const [comment, setComment] = React.useState("");
  const [stepUp, setStepUp] = React.useState<null | Record<string, unknown>>(null);
  const [openEv, setOpenEv] = React.useState<string | null>(a.evidence[0]?.id ?? null);
  const elapsed = (now - new Date(a.created_at).getTime()) / (new Date(a.expires_at).getTime() - new Date(a.created_at).getTime());

  const send = async (body: Record<string, unknown>, verified = false) => {
    setBusy(true);
    try {
      const res = await api<A>(`/api/v1/approvals/${a.id}/respond`, { method: "POST", json: { ...body, comment: comment || undefined, step_up: verified ? { method: "passkey", verified: true } : undefined } });
      toast.success(res.status === "pending" ? "Signed — waiting for the remaining quorum" : `Decision recorded: ${res.status.replace("_", " ")}`, { description: res.receipt_id ? `Receipt ${res.receipt_id} issued and returned to ${a.integration.name}` : undefined });
      onDone();
    } catch (e) {
      const err = e as Error & { code?: string; remediation?: string };
      if (err.code === "step_up_required") setStepUp(body);
      else toast.error(err.message, { description: err.remediation });
    } finally {
      setBusy(false);
    }
  };
  const act = (body: Record<string, unknown>) => (body.decision !== "reject" && a.step_up === "biometric" ? setStepUp(body) : send(body));

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-6 py-5">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          <Bot className="size-4" /> {a.actor.name} <span className="capitalize">({a.actor.type})</span> via {a.integration.name}
          <span className="ml-auto flex items-center gap-1.5"><Clock3 className="size-3.5" /> requested <RelTime iso={a.created_at} /></span>
        </div>
        <h2 className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.025em]">{a.title}</h2>
        {a.intent && <p className="mt-1.5 text-[15px] text-ink-2">“{a.intent}”</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <RiskBadge level={a.risk.level} score={a.risk.score} />
          {a.status === "pending" ? <Badge tone="cobalt"><Countdown to={a.expires_at} /></Badge> : <StatusBadge status={a.status} />}
          {a.step_up === "biometric" && <Badge tone="neutral"><Fingerprint className="size-3.5" /> Step-up required</Badge>}
          <Badge tone="neutral"><Users className="size-3.5" /> {ROUTE_LABEL[a.route] ?? a.route} · {a.assignees.length}</Badge>
          {a.escalation_level > 0 && <Badge tone="high">Escalated</Badge>}
        </div>
        {a.status === "pending" && (
          <div className="mt-3 max-w-sm">
            <div className="mb-1 flex justify-between text-[11.5px] text-muted"><span>SLA</span><span className="tnum">{Math.round(Math.min(1, elapsed) * 100)}% of TTL used</span></div>
            <Meter value={Math.min(1, elapsed) * 100} tone={elapsed > 0.75 ? "critical" : elapsed > 0.5 ? "high" : "cobalt"} />
          </div>
        )}
      </div>

      <div className="grid gap-0 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5 px-6 py-5">
          <section className="rounded-xl border border-cobalt/20 bg-cobalt-50/50 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-cobalt"><Shield className="size-3.5" /> Policy reason</div>
            <p className="mt-1 text-[14.5px] text-ink">{a.policy.reason}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[11.5px] text-muted">
              <Link href={`/console/policies/${a.policy.id}`} className="hover:text-cobalt hover:underline">{a.policy.name} v{a.policy.version}</Link>
              <span>rule {a.policy.rule_id}</span>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Why it's risky</h3>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {a.risk.reasons.map((r) => (
                <li key={r.code} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
                  <span>{r.label}</span>
                  <span className={cn("tnum text-[12px] font-semibold", r.weight > 0 ? "text-high" : "text-low")}>{r.weight > 0 ? `+${r.weight}` : r.weight}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Evidence</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {a.evidence.map((e) => (
                <li key={e.id}>
                  <button className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left" onClick={() => setOpenEv((o) => (o === e.id ? null : e.id))} aria-expanded={openEv === e.id}>
                    <span className="w-28 shrink-0 text-[13px] font-medium">{e.label}</span>
                    <span className={cn("min-w-0 flex-1 text-[13px] text-ink-2", openEv !== e.id && "truncate")}>{e.value}</span>
                    <ChevronDown className={cn("size-4 shrink-0 text-faint transition", openEv === e.id && "rotate-180")} />
                  </button>
                  {openEv === e.id && (
                    <div className="flex flex-wrap gap-2 px-3.5 pb-3 pl-[8.6rem] text-[11.5px] text-muted">
                      <span>Source: {e.source}</span>
                      {e.freshness && <span>· Freshness: {e.freshness}</span>}
                      {e.confidence && <span>· Confidence: {e.confidence}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {a.blast_radius.length > 0 && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Blast radius — if approved</h3>
              <ul className="space-y-1.5">
                {a.blast_radius.map((b) => (
                  <li key={b} className="flex gap-2 text-[13.5px]"><ArrowRight className="mt-0.5 size-4 shrink-0 text-high" /> {b}</li>
                ))}
              </ul>
            </section>
          )}

          {a.status === "pending" && a.can_respond && (
            <section className="space-y-3 border-t border-line pt-5">
              {a.safe_alternatives.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-low/25 bg-low-bg/60 px-4 py-3">
                  <Sparkles className="size-5 text-low" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold">{s.label}</div>
                    <div className="text-[12.5px] text-ink-2">{s.description}</div>
                  </div>
                  <Button size="sm" className="bg-low text-white hover:bg-[#0b6a3f]" disabled={busy} onClick={() => act({ decision: "safe_alternative", alternative_id: s.id })}>Use safe alternative</Button>
                </div>
              ))}
              <AnimatePresence>
                {edit && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="grid gap-3 sm:grid-cols-2">
                    {a.editable_fields.map((f) => {
                      const max = f.max ?? Number(a.parameters[f.key] ?? 0);
                      return (
                        <label key={f.key} className="block text-[13px]">
                          <span className="font-medium text-ink-2">{f.label}</span> <span className="text-muted">(≤ {max.toLocaleString()})</span>
                          <input type="number" className={cn(inputCls, "tnum mt-1")} min={f.min} max={max} value={vals[f.key] ?? Number(a.parameters[f.key] ?? max)} onChange={(e) => setVals((v) => ({ ...v, [f.key]: Number(e.target.value) }))} />
                        </label>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional note for the audit trail" rows={2} className={cn(inputCls, "h-auto py-2")} />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy} onClick={() => (edit ? act({ decision: "approve_modified", modified_parameters: Object.fromEntries(a.editable_fields.map((f) => [f.key, vals[f.key] ?? Number(a.parameters[f.key] ?? 0)])) }) : act({ decision: "approve" }))}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} {edit ? "Approve with edits" : "Approve"}
                </Button>
                {a.editable_fields.length > 0 && <Button variant="secondary" onClick={() => setEdit((e) => !e)}><Pencil className="size-4" /> {edit ? "Cancel edit" : "Edit & approve"}</Button>}
                <Button variant="secondary" className="!text-critical" disabled={busy} onClick={() => act({ decision: "reject" })}><X className="size-4" /> Reject</Button>
              </div>
            </section>
          )}
          {a.status === "pending" && !a.can_respond && <p className="rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-muted">{a.my_response ? "You already signed this request — waiting for the remaining approvers." : "You're not an assigned approver for this route."}</p>}
        </div>

        <div className="space-y-5 border-t border-line bg-surface-2/40 px-5 py-5 lg:border-l lg:border-t-0">
          {a.quorum_progress && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Quorum</h3>
              <div className="tnum text-[22px] font-semibold">{a.quorum_progress.approvals} <span className="text-[14px] font-normal text-muted">of {a.quorum_progress.required} required</span></div>
              <div className="mt-2"><Meter value={a.quorum_progress.approvals} max={a.quorum_progress.required} tone="low" /></div>
            </section>
          )}
          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Assigned approvers</h3>
            <ul className="space-y-2">
              {a.assignees.map((uid) => {
                const u = users[uid];
                const r = a.responses.find((x) => x.user_id === uid);
                return (
                  <li key={uid} className="flex items-center gap-2.5 text-[13px]">
                    <Avatar name={u?.name ?? uid} color={u?.color} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{u?.name ?? uid}</span>
                      <span className="block truncate text-[11.5px] text-muted">{u?.title}</span>
                    </span>
                    {r && <Badge tone={r.decision === "reject" ? "critical" : "low"}>{r.decision === "reject" ? "Rejected" : "Signed"}</Badge>}
                  </li>
                );
              })}
            </ul>
          </section>
          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Timeline</h3>
            <div className="text-[13px]">
            <TrustTimeline action={null} approval={a} receipt={null} />
            </div>
          </section>
          {a.receipt_id && (
            <Link href={`/console/receipts/${a.receipt_id}`} className="flex items-center justify-between rounded-xl border border-line bg-surface px-3.5 py-3 text-[13px] font-medium hover:border-cobalt/40">
              Receipt <Mono>{a.receipt_id}</Mono>
            </Link>
          )}
        </div>
      </div>

      <StepUpDialog key={stepUp ? "open" : "closed"} open={!!stepUp} onCancel={() => setStepUp(null)} onVerified={() => { const b = stepUp!; setStepUp(null); void send(b, true); }} title={a.title} />
    </Card>
  );
}

function StepUpDialog({ open, onCancel, onVerified, title }: { open: boolean; onCancel: () => void; onVerified: () => void; title: string }) {
  const [phase, setPhase] = React.useState<"idle" | "verifying" | "ok">("idle");
  const verify = () => {
    setPhase("verifying");
    setTimeout(() => setPhase("ok"), 900);
    setTimeout(onVerified, 1400);
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-6 text-center shadow-pop">
          <div className={cn("mx-auto grid size-16 place-items-center rounded-2xl", phase === "ok" ? "bg-low-bg text-low" : "bg-cobalt-50 text-cobalt")}>
            {phase === "ok" ? <CheckCircle2 className="size-8" /> : phase === "verifying" ? <Loader2 className="size-8 animate-spin" /> : <KeyRound className="size-8" />}
          </div>
          <Dialog.Title className="mt-4 text-[18px] font-semibold">Verify it's you</Dialog.Title>
          <Dialog.Description className="mt-1 text-[13.5px] text-muted">Policy requires step-up verification to approve “{title}”. Your passkey proves possession; the server re-checks assignment, state and expiry.</Dialog.Description>
          <div className="mt-5 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" className="flex-1" onClick={verify} disabled={phase !== "idle"}><Fingerprint className="size-4" /> Use passkey</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
