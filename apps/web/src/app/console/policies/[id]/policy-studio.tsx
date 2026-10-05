"use client";
import { useRouter } from "next/navigation";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Check, FlaskConical, GitCompareArrows, Loader2, Play, Rocket, Save, ShieldCheck, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { Policy, PolicyRule, PolicyVersion } from "@orbis/policy-core";
import { api } from "@/components/console/live";
import { Badge, Button, Card, CardHeader, Mono, Segmented, StatusBadge, inputCls } from "@/components/ui";
import { conditionText, EFFECT_LABEL, EFFECT_TONE, ruleSignature } from "@/lib/policy-text";
import { cn, dateTime, ROUTE_LABEL } from "@/lib/format";

const EFFECTS = ["allow", "allow_log", "warn", "require_confirmation", "require_approval", "require_quorum", "deny"] as const;

interface SimResult {
  total: number;
  changed: number;
  status_changed: number;
  current: Record<string, number>;
  candidate: Record<string, number>;
  rows: Array<{ action_id: string; title: string; actor: string; current: { status: string; effect: string; rule?: string }; candidate: { status: string; effect: string; rule?: string }; risk: number }>;
  live_version: number | null;
  candidate_version: number;
}

export function PolicyStudio({ policy, admins, hits }: { policy: Policy; admins: Array<{ id: string; name: string }>; hits: Record<string, number> }) {
  const router = useRouter();
  const published = policy.versions.find((v) => v.version === policy.current_version)!;
  const draft = policy.versions.find((v) => v.status === "draft");
  const [tab, setTab] = React.useState<"rules" | "studio" | "versions">(draft ? "studio" : "rules");
  const [rules, setRules] = React.useState<PolicyRule[]>(() => structuredClone((draft ?? published).rules));
  const [note, setNote] = React.useState(draft?.change_note ?? "");
  const [sim, setSim] = React.useState<SimResult | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [second, setSecond] = React.useState(admins[0]?.id ?? "");
  const dirty = JSON.stringify(rules) !== JSON.stringify((draft ?? published).rules);

  const update = (ri: number, fn: (r: PolicyRule) => void) =>
    setRules((rs) => {
      const next = structuredClone(rs);
      fn(next[ri]);
      return next;
    });

  const simulate = async () => {
    setBusy("sim");
    try {
      setSim(await api<SimResult>("/api/v1/policies/simulate", { method: "POST", json: { policy_id: policy.id, rules } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    try {
      await api(`/api/v1/policies/${policy.id}/draft`, { method: "PUT", json: { rules, change_note: note || "Edited in Policy Studio" } });
      toast.success("Draft saved", { description: "Published versions are untouched until a second admin co-signs." });
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const publish = async () => {
    setBusy("pub");
    try {
      await api(`/api/v1/policies/${policy.id}/draft`, { method: "PUT", json: { rules, change_note: note || "Edited in Policy Studio" } });
      const res = await api<{ version: number; checksum: string }>(`/api/v1/policies/${policy.id}/publish`, { method: "POST", json: { second_approver_id: second } });
      toast.success(`v${res.version} is live`, { description: `Gateway now enforces it · checksum ${res.checksum.slice(0, 12)}…` });
      setPublishOpen(false);
      setSim(null);
      setTab("rules");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented value={tab} onChange={setTab} options={[{ value: "rules", label: `Live rules · v${published.version}` }, { value: "studio", label: draft ? `Draft v${draft.version}` : "Edit & simulate" }, { value: "versions", label: `History · ${policy.versions.length}` }]} />
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <ShieldCheck className="size-4 text-low" /> v{published.version} published {published.published_at ? dateTime(published.published_at) : ""} by {published.created_by}
        </div>
      </div>

      {tab === "rules" && <RuleList rules={published.rules} hits={hits} />}

      {tab === "versions" && <Versions policy={policy} />}

      {tab === "studio" && (
        <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
          <Card>
            <CardHeader
              title={draft ? `Draft v${draft.version}` : `New draft from v${published.version}`}
              description="Edit effects, thresholds and step-up. Changes are simulated against the last 1,500 real actions before anything goes live."
              action={dirty ? <Badge tone="medium">Unsaved changes</Badge> : undefined}
            />
            <div className="space-y-3 p-5">
              {rules.map((r, ri) => (
                <div key={r.id} className="rounded-xl border border-line p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[14px] font-semibold">{r.name}</div>
                    <select value={r.effect} onChange={(e) => update(ri, (x) => void (x.effect = e.target.value as PolicyRule["effect"]))} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[12.5px] font-medium" aria-label={`Effect for ${r.name}`}>
                      {EFFECTS.map((e) => <option key={e} value={e}>{EFFECT_LABEL[e]}</option>)}
                    </select>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    <span className="font-mono text-[11px] font-semibold text-cobalt">WHEN</span>
                    {(r.when.all ?? []).map((c, ci) => (
                      <span key={ci} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 ring-1 ring-inset ring-line">
                        {typeof c.value === "number" && c.field !== "resource.classification_rank" ? (
                          <>
                            {conditionText({ ...c, value: undefined as never }).replace(/ undefined$/, "")}
                            <input type="number" value={c.value} onChange={(e) => update(ri, (x) => void (x.when.all![ci].value = Number(e.target.value)))} className="tnum h-6 w-24 rounded border border-line-strong bg-surface px-1.5 text-[12px]" aria-label={`Threshold for ${c.field}`} />
                          </>
                        ) : (
                          conditionText(c)
                        )}
                      </span>
                    ))}
                  </div>
                  {["require_approval", "require_quorum", "require_confirmation"].includes(r.effect) && (
                    <label className="mt-2.5 flex items-center gap-2 text-[12.5px] text-ink-2">
                      <input type="checkbox" checked={r.step_up === "biometric"} onChange={(e) => update(ri, (x) => void (x.step_up = e.target.checked ? "biometric" : "none"))} className="accent-[var(--color-cobalt)]" />
                      Require Face ID / passkey step-up · routes to {ROUTE_LABEL[r.route ?? "security"] ?? r.route}
                    </label>
                  )}
                </div>
              ))}
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Change note (shown in the audit trail)" className={inputCls} />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={simulate} disabled={!!busy}>
                  {busy === "sim" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Simulate against history
                </Button>
                <Button onClick={save} disabled={!!busy || (!dirty && !!draft)}>
                  {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save draft
                </Button>
                <Button variant="ghost" onClick={() => (setRules(structuredClone(published.rules)), setSim(null))}>
                  <Undo2 className="size-4" /> Reset to live
                </Button>
              </div>
            </div>
          </Card>

          <Card className="h-fit">
            <CardHeader title="Policy simulator" description="Live vs candidate decisions on real recent traffic" action={sim && <Button size="sm" variant="primary" onClick={() => setPublishOpen(true)}><Rocket className="size-4" /> Publish</Button>} />
            {!sim ? (
              <div className="flex flex-col items-center px-6 py-12 text-center">
                <FlaskConical className="size-8 text-cobalt" />
                <p className="mt-3 max-w-xs text-[13.5px] text-muted">Run the simulator to see exactly which past actions would change decision under this draft — before a single customer request is affected.</p>
                {draft && draft.version === 18 && policy.id === "pol_conf_external" && <p className="mt-3 text-[12.5px] text-ink-2">Tip: draft v18 hard-denies restricted egress and auto-allows the approved internal model.</p>}
              </div>
            ) : (
              <SimView sim={sim} />
            )}
          </Card>
        </div>
      )}

      <Dialog.Root open={publishOpen} onOpenChange={setPublishOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-surface p-6 shadow-pop">
            <Dialog.Title className="text-[18px] font-semibold">Publish {policy.name}</Dialog.Title>
            <Dialog.Description className="mt-1 text-[13.5px] text-muted">
              {sim ? `${sim.status_changed} of ${sim.total} historical decisions would change (${sim.changed - sim.status_changed} more only change effect).` : ""} Northstar requires a second policy admin to co-sign every publish. The new version becomes immutable and is enforced by the gateway immediately.
            </Dialog.Description>
            <label className="mt-4 block text-[13px] font-medium">
              Second approver
              <select value={second} onChange={(e) => setSecond(e.target.value)} className={cn(inputCls, "mt-1.5")}>
                {admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setPublishOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={publish} disabled={busy === "pub"}>{busy === "pub" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Co-sign & publish</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function SimView({ sim }: { sim: SimResult }) {
  const statuses = ["allow", "warn", "approval_required", "deny"];
  return (
    <div className="p-5">
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl bg-surface-2 px-3 py-2.5"><div className="tnum text-[20px] font-semibold">{sim.total.toLocaleString()}</div><div className="text-[11.5px] text-muted">actions replayed</div></div>
        <div className={cn("rounded-xl px-3 py-2.5", sim.status_changed ? "bg-cobalt-50" : "bg-low-bg")}><div className="tnum text-[20px] font-semibold">{sim.status_changed}</div><div className="text-[11.5px] text-muted">decisions change</div></div>
        <div className="rounded-xl bg-surface-2 px-3 py-2.5"><div className="tnum text-[20px] font-semibold">{sim.changed - sim.status_changed}</div><div className="text-[11.5px] text-muted">effect-only (e.g. now logged)</div></div>
      </div>
      <table className="mt-4 w-full text-[13px]">
        <thead className="text-[12px] text-muted"><tr><th className="py-1.5 text-left font-medium">Decision</th><th className="text-right font-medium">Live</th><th className="text-right font-medium">Candidate</th><th className="text-right font-medium">Δ</th></tr></thead>
        <tbody className="tnum divide-y divide-line">
          {statuses.map((s) => {
            const a = sim.current[s] ?? 0;
            const b = sim.candidate[s] ?? 0;
            return (
              <tr key={s}>
                <td className="py-1.5"><StatusBadge status={s} /></td>
                <td className="text-right">{a}</td>
                <td className="text-right font-medium">{b}</td>
                <td className={cn("text-right font-semibold", b - a > 0 ? "text-high" : b - a < 0 ? "text-low" : "text-faint")}>{b - a > 0 ? `+${b - a}` : b - a}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h4 className="mb-2 mt-5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted"><GitCompareArrows className="size-3.5" /> Changed decisions</h4>
      {sim.rows.length === 0 ? (
        <p className="text-[13px] text-muted">No historical decision changes. This draft is safe to publish from a behavior standpoint.</p>
      ) : (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto">
          {sim.rows.slice(0, 60).map((r) => (
            <li key={r.action_id} className="rounded-lg border border-line px-3 py-2 text-[12.5px]">
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.title}</span><Mono className="text-[11px] text-faint">{r.actor}</Mono></div>
              <div className="mt-1 flex items-center gap-1.5">
                <Badge tone={EFFECT_TONE[r.current.effect]}>{EFFECT_LABEL[r.current.effect]}</Badge>
                <ArrowRight className="size-3.5 text-faint" />
                <Badge tone={EFFECT_TONE[r.candidate.effect]}>{EFFECT_LABEL[r.candidate.effect]}</Badge>
                {r.current.status !== r.candidate.status && <span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-cobalt">decision change</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RuleList({ rules, hits }: { rules: PolicyRule[]; hits: Record<string, number> }) {
  return (
    <div className="space-y-3">
      {rules.map((r) => (
        <Card key={r.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-semibold">{r.name}</h3>
                <Mono className="text-faint">{r.id}</Mono>
              </div>
              <p className="mt-1 text-[13.5px] text-ink-2">{r.reason}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="tnum text-[12px] text-muted">{(hits[r.id] ?? 0).toLocaleString()} matches / 28d</span>
              <Badge tone={EFFECT_TONE[r.effect]}>{EFFECT_LABEL[r.effect]}</Badge>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <span className="font-mono text-[11px] font-semibold text-cobalt">WHEN</span>
            {(r.when.all ?? []).map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-[11px] font-semibold text-faint">AND</span>}
                <span className="rounded-md bg-surface-2 px-2 py-1 ring-1 ring-inset ring-line">{conditionText(c)}</span>
              </React.Fragment>
            ))}
          </div>
          {(r.route || r.safe_alternatives?.length || r.editable_fields?.length) && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 text-[12.5px] text-muted">
              {r.route && <span>Route → <span className="text-ink-2">{ROUTE_LABEL[r.route] ?? r.route}</span></span>}
              {r.step_up === "biometric" && <span>Step-up → <span className="text-ink-2">Face ID / passkey</span></span>}
              {r.quorum && <span>Quorum → <span className="text-ink-2">{r.quorum.required} of {r.quorum.of}</span></span>}
              {r.editable_fields?.length ? <span>Editable → <span className="text-ink-2">{r.editable_fields.map((f) => f.label).join(", ")}</span></span> : null}
              {r.safe_alternatives?.length ? <span>Safe alternative → <span className="text-low">{r.safe_alternatives.map((s) => s.label).join(", ")}</span></span> : null}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Versions({ policy }: { policy: Policy }) {
  const sorted = [...policy.versions].sort((a, b) => b.version - a.version);
  const [cmp, setCmp] = React.useState<[number, number]>([sorted[1]?.version ?? sorted[0].version, sorted[0].version]);
  const va = policy.versions.find((v) => v.version === cmp[0])!;
  const vb = policy.versions.find((v) => v.version === cmp[1])!;
  const diff = diffRules(va, vb);
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card>
        <ul className="divide-y divide-line">
          {sorted.map((v) => (
            <li key={v.version} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[13px] font-semibold">v{v.version}</span>
                <Badge tone={v.status === "published" ? "low" : v.status === "draft" ? "cobalt" : "neutral"}>{v.status}</Badge>
              </div>
              <p className="mt-1 text-[13px] text-ink-2">{v.change_note}</p>
              <div className="mt-1 text-[12px] text-muted">{v.created_by} · {dateTime(v.published_at ?? v.created_at)}{v.checksum ? ` · ${v.checksum.slice(0, 10)}` : ""}</div>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader
          title="Version diff"
          action={
            <div className="flex items-center gap-1.5 text-[13px]">
              <select value={cmp[0]} onChange={(e) => setCmp([Number(e.target.value), cmp[1]])} className="h-8 rounded-lg border border-line-strong px-2" aria-label="Base version">{sorted.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}</select>
              <ArrowRight className="size-4 text-faint" />
              <select value={cmp[1]} onChange={(e) => setCmp([cmp[0], Number(e.target.value)])} className="h-8 rounded-lg border border-line-strong px-2" aria-label="Compare version">{sorted.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}</select>
            </div>
          }
        />
        <ul className="space-y-2 p-5 font-mono text-[12.5px]">
          {diff.length === 0 && <li className="font-sans text-muted">No rule differences.</li>}
          {diff.map((d) => (
            <li key={d.id + d.kind} className={cn("rounded-lg px-3 py-2", d.kind === "added" ? "bg-low-bg text-low" : d.kind === "removed" ? "bg-critical-bg text-critical" : "bg-medium-bg text-medium")}>
              {d.kind === "added" ? "+ " : d.kind === "removed" ? "− " : "~ "}
              {d.id} <span className="font-sans">{d.text}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function diffRules(a: PolicyVersion, b: PolicyVersion) {
  const out: Array<{ id: string; kind: "added" | "removed" | "changed"; text: string }> = [];
  for (const r of b.rules) {
    const prev = a.rules.find((x) => x.id === r.id);
    if (!prev) out.push({ id: r.id, kind: "added", text: `${r.name} → ${EFFECT_LABEL[r.effect]}` });
    else if (ruleSignature(prev) !== ruleSignature(r)) out.push({ id: r.id, kind: "changed", text: prev.effect !== r.effect ? `effect ${EFFECT_LABEL[prev.effect]} → ${EFFECT_LABEL[r.effect]}` : "conditions or routing changed" });
  }
  for (const r of a.rules) if (!b.rules.some((x) => x.id === r.id)) out.push({ id: r.id, kind: "removed", text: r.name });
  return out;
}
