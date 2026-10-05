"use client";
import { useRouter } from "next/navigation";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bot, Cpu, Loader2, Snowflake, Sun, User, Workflow, Zap } from "lucide-react";
import { toast } from "sonner";
import { Sparkline } from "@/components/charts";
import { api } from "@/components/console/live";
import { RelTime } from "@/components/console/time";
import { Badge, Button, Card, Mono, inputCls } from "@/components/ui";
import { cn, dateTime } from "@/lib/format";

export interface ActorVM {
  id: string;
  name: string;
  type: string;
  description: string;
  owner_team: string;
  integration: string;
  trust: string;
  baseline_per_hour: number;
  tools: Array<{ tool: string; risk_class: string }>;
  stats: { total: number; human: number; blocked: number; anomalies: number; hourly: number[] } | null;
  freeze: { id: string; reason: string; by: string; at: string; channel: string; blocked: number } | null;
}

const ICON = { agent: Bot, workflow: Workflow, automation: Zap, service: Cpu, human: User } as const;

export function ActorsView({ actors, history, canFreeze, canUnfreeze }: { actors: ActorVM[]; history: Array<{ id: string; actor: string; reason: string; by: string; at: string; lifted_at: string | null; lifted_by: string | null; lift_reason: string | null; blocked: number; channel: string }>; canFreeze: boolean; canUnfreeze: boolean }) {
  const router = useRouter();
  const [target, setTarget] = React.useState<{ actor: ActorVM; mode: "freeze" | "unfreeze" } | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      if (target.mode === "freeze") await api(`/api/v1/actors/${target.actor.id}/freeze`, { method: "POST", json: { reason } });
      else await api(`/api/v1/actors/${target.actor.id}/freeze`, { method: "DELETE", json: { reason } });
      toast.success(target.mode === "freeze" ? `${target.actor.name} frozen — gateway now denies every new request` : `${target.actor.name} restored`);
      setTarget(null);
      setReason("");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        {actors.map((a) => {
          const Icon = ICON[a.type as keyof typeof ICON] ?? Bot;
          const peak = Math.max(...(a.stats?.hourly ?? [0]));
          const anomalous = a.stats && a.baseline_per_hour > 0 && peak > a.baseline_per_hour * 3;
          return (
            <Card key={a.id} className={cn("p-4", a.freeze && "border-critical/40 bg-critical-bg/30")}>
              <div className="flex items-start gap-3">
                <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", a.freeze ? "bg-critical-bg text-critical" : "bg-cobalt-50 text-cobalt")}>
                  {a.freeze ? <Snowflake className="size-5" /> : <Icon className="size-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-semibold">{a.name}</h3>
                    <Badge tone="neutral" className="capitalize">{a.type}</Badge>
                    {a.trust !== "trusted" && <Badge tone={a.trust === "watch" ? "high" : "medium"}>{a.trust === "watch" ? "On watch" : "New"}</Badge>}
                    {a.freeze && <Badge tone="critical"><Snowflake className="size-3.5" /> Frozen</Badge>}
                  </div>
                  <p className="mt-0.5 text-[13px] text-muted">{a.description}</p>
                  <div className="mt-1 text-[12px] text-faint">{a.owner_team} · {a.integration} · <Mono className="text-[11px] text-faint">{a.id}</Mono></div>
                </div>
              </div>
              <div className="mt-3 flex items-end justify-between gap-4">
                <div className="flex flex-wrap gap-1">
                  {a.tools.map((t) => (
                    <span key={t.tool} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2 ring-1 ring-inset ring-line">
                      {t.tool} <span className={t.risk_class === "high" ? "text-high" : t.risk_class === "medium" ? "text-medium" : "text-low"}>·{t.risk_class}</span>
                    </span>
                  ))}
                </div>
                {a.stats && (
                  <div className="shrink-0 text-right">
                    <Sparkline values={a.stats.hourly} width={140} height={32} accent={anomalous ? "var(--color-critical)" : "var(--color-cobalt)"} label={`${a.name} hourly volume, 48 hours`} />
                    <div className="tnum text-[11px] text-muted">48h · peak {peak}/h · baseline {a.baseline_per_hour}/h</div>
                  </div>
                )}
              </div>
              {a.freeze && (
                <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-[12.5px] text-ink-2 ring-1 ring-critical/20">
                  <span className="font-medium text-critical">Frozen</span> by {a.freeze.by} via {a.freeze.channel} · {dateTime(a.freeze.at)} — “{a.freeze.reason}” · {a.freeze.blocked} blocked
                </div>
              )}
              <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
                <span className="tnum">{a.stats?.total ?? 0} actions · {a.stats?.human ?? 0} human · {a.stats?.blocked ?? 0} blocked · {a.stats?.anomalies ?? 0} anomalies</span>
                {a.freeze ? (
                  <Button size="sm" disabled={!canUnfreeze} onClick={() => setTarget({ actor: a, mode: "unfreeze" })}><Sun className="size-4" /> Restore</Button>
                ) : (
                  <Button size="sm" variant="secondary" className="!text-critical" disabled={!canFreeze || a.id === "sandbox-agent"} onClick={() => setTarget({ actor: a, mode: "freeze" })}><Snowflake className="size-4" /> Freeze</Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-2.5 mt-8 text-[12px] font-semibold uppercase tracking-wider text-muted">Freeze history</h2>
      <Card>
        <ul className="divide-y divide-line text-[13.5px]">
          {history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
              <Snowflake className="size-4 text-critical" />
              <span className="font-medium">{h.actor}</span>
              <span className="flex-1 text-muted">“{h.reason}” — {h.by} via {h.channel}, {dateTime(h.at)}</span>
              {h.lifted_at ? <Badge tone="low">Restored by {h.lifted_by} · <RelTime iso={h.lifted_at} /></Badge> : <Badge tone="critical">Active · {h.blocked} blocked</Badge>}
            </li>
          ))}
        </ul>
      </Card>

      <Dialog.Root open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-6 shadow-pop">
            <Dialog.Title className="flex items-center gap-2 text-[18px] font-semibold">
              {target?.mode === "freeze" ? <Snowflake className="size-5 text-critical" /> : <Sun className="size-5 text-low" />}
              {target?.mode === "freeze" ? `Freeze ${target?.actor.name}?` : `Restore ${target?.actor.name}?`}
            </Dialog.Title>
            <Dialog.Description className="mt-1.5 text-[13.5px] text-muted">
              {target?.mode === "freeze"
                ? "Every new gateway request from this actor will be denied immediately and its pending approvals cancelled. This is recorded in the audit trail."
                : "Restoring requires an admin and a reason. New requests will be evaluated by policy again."}
            </Dialog.Description>
            <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={target?.mode === "freeze" ? "Why are you freezing this actor?" : "What was fixed?"} className={cn(inputCls, "mt-4 h-auto py-2")} />
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setTarget(null)}>Cancel</Button>
              <Button variant={target?.mode === "freeze" ? "danger" : "primary"} disabled={busy || reason.trim().length < 4} onClick={submit}>
                {busy && <Loader2 className="size-4 animate-spin" />} {target?.mode === "freeze" ? "Freeze now" : "Restore"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
