"use client";
import * as React from "react";
import { Download, Link2, Loader2, Search, ShieldCheck, ShieldX } from "lucide-react";
import type { AuditEvent } from "@/lib/domain";
import { api } from "@/components/console/live";
import { Badge, Button, Card, Mono, inputCls } from "@/components/ui";
import { cn, dateTime } from "@/lib/format";

const TYPES = [
  { k: "", label: "All" },
  { k: "action.", label: "Actions" },
  { k: "approval.", label: "Approvals" },
  { k: "policy.", label: "Policy changes" },
  { k: "freeze.", label: "Freezes" },
  { k: "api_key.", label: "Keys" },
  { k: "device.", label: "Devices" },
  { k: "auth.", label: "Sign-ins" },
  { k: "security.", label: "Security" },
];

export function AuditView({ initial, total }: { initial: AuditEvent[]; total: number }) {
  const [events, setEvents] = React.useState(initial);
  const [type, setType] = React.useState("");
  const [q, setQ] = React.useState("");
  const [verify, setVerify] = React.useState<{ ok: boolean; checked: number; head?: string; broken_at?: number; ms: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(async () => {
      const res = await api<{ data: AuditEvent[] }>(`/api/v1/audit/events?limit=300&type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`);
      setEvents(res.data);
    }, 200);
    return () => clearTimeout(t);
  }, [type, q]);

  const runVerify = async () => {
    setBusy(true);
    try {
      setVerify(await api("/api/v1/audit/verify"));
    } finally {
      setBusy(false);
    }
  };
  const exportJsonl = () => {
    const blob = new Blob([events.map((e) => JSON.stringify(e)).join("\n")], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `orbis-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 p-4">
        <div className={cn("grid size-11 place-items-center rounded-xl", verify ? (verify.ok ? "bg-low-bg text-low" : "bg-critical-bg text-critical") : "bg-cobalt-50 text-cobalt")}>
          {verify && !verify.ok ? <ShieldX className="size-6" /> : <ShieldCheck className="size-6" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{verify ? (verify.ok ? `Chain intact — ${verify.checked.toLocaleString()} events re-hashed in ${verify.ms}ms` : `Chain broken at event #${verify.broken_at}`) : `Tamper-evident trail · ${total.toLocaleString()} events`}</div>
          <div className="text-[12.5px] text-muted">{verify?.head ? <>Head <Mono className="text-[11.5px]">{verify.head.slice(0, 48)}…</Mono></> : "Each event commits to the SHA-256 of the previous one. Editing any row breaks every hash after it."}</div>
        </div>
        <Button variant="primary" onClick={runVerify} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />} Verify chain</Button>
        <Button onClick={exportJsonl}><Download className="size-4" /> Export JSONL</Button>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search summary, person, target…" className={cn(inputCls, "h-9 pl-9")} aria-label="Search audit trail" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TYPES.map((t) => (
            <button key={t.k} onClick={() => setType(t.k)} className={cn("rounded-full px-3 py-1 text-[12.5px] font-medium ring-1 ring-inset", type === t.k ? "bg-ink text-white ring-ink" : "bg-surface text-ink-2 ring-line hover:ring-line-strong")}>{t.label}</button>
          ))}
        </div>
      </div>

      <Card>
        <ol className="divide-y divide-line">
          {events.map((e) => (
            <li key={e.id}>
              <button className="grid w-full grid-cols-[64px_1fr_auto] items-start gap-3 px-5 py-2.5 text-left hover:bg-surface-2/40 sm:grid-cols-[64px_150px_1fr_auto]" onClick={() => setExpanded((x) => (x === e.id ? null : e.id))} aria-expanded={expanded === e.id}>
                <span className="tnum pt-0.5 font-mono text-[11.5px] text-faint">#{e.seq}</span>
                <span className="hidden pt-0.5 sm:block"><Badge tone={e.type.startsWith("security") ? "critical" : e.type.startsWith("freeze") ? "high" : e.type.startsWith("policy") ? "cobalt" : "neutral"} className="font-mono text-[11px]">{e.type}</Badge></span>
                <span className="min-w-0 text-[13.5px]">
                  <span className="text-ink">{e.summary}</span>
                  <span className="mt-0.5 block text-[12px] text-muted">{e.actor.name} · {e.actor.kind}</span>
                </span>
                <span className="tnum whitespace-nowrap text-[12px] text-muted">{dateTime(e.at)}</span>
              </button>
              {expanded === e.id && (
                <div className="grid gap-1 bg-surface-2/50 px-5 py-3 font-mono text-[11.5px] text-ink-2">
                  <div>id {e.id}{e.target ? ` · target ${e.target.type}:${e.target.id}` : ""}</div>
                  <div>prev_hash {e.prev_hash}</div>
                  <div>hash&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; {e.hash}</div>
                  {e.data && <div>data {JSON.stringify(e.data)}</div>}
                </div>
              )}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
