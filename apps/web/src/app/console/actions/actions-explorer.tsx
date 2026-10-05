"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { ArrowDown, ArrowUp, Download, Search, SearchX } from "lucide-react";
import { ActionInspector } from "@/components/console/action-inspector";
import { RelTime } from "@/components/console/time";
import { Button, EmptyState, RiskBadge, StatusBadge, inputCls } from "@/components/ui";
import { cn, usd } from "@/lib/format";

export interface Row {
  id: string;
  title: string;
  action_type: string;
  actor: { id: string; name: string; type: string };
  integration: { id: string; name: string };
  received_at: string;
  final_status: string;
  risk: { score: number; level: string };
  rule: string | null;
  outcome: string | null;
  mode: string;
  amount_usd: number | null;
  latency_ms: number;
}

type SortKey = "received_at" | "risk" | "title" | "final_status";
const STATUS_FILTERS = ["all", "pending", "allow", "warn", "deny", "approved", "approved_modified", "rejected", "expired"] as const;

export function ActionsExplorer({ rows, integrations, actors }: { rows: Row[]; integrations: Array<{ id: string; name: string }>; actors: Array<{ id: string; name: string }> }) {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const selected = sp.get("id");
  const [q, setQ] = React.useState(sp.get("q") ?? "");
  const [status, setStatus] = React.useState<string>(sp.get("status") ?? "all");
  const [integration, setIntegration] = React.useState(sp.get("integration") ?? "");
  const [actor, setActor] = React.useState(sp.get("actor") ?? "");
  const [risk, setRisk] = React.useState(sp.get("risk") ?? "");
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({ key: "received_at", dir: -1 });
  const [limit, setLimit] = React.useState(80);

  const select = (id: string | null) => {
    const p = new URLSearchParams(sp.toString());
    if (id) p.set("id", id);
    else p.delete("id");
    router.replace(`${path}?${p.toString()}`, { scroll: false });
  };

  const filtered = React.useMemo(() => {
    const ql = q.toLowerCase();
    const out = rows.filter(
      (r) =>
        (status === "all" || r.final_status === status) &&
        (!integration || r.integration.id === integration) &&
        (!actor || r.actor.id === actor) &&
        (!risk || r.risk.level === risk) &&
        (!ql || `${r.title} ${r.actor.name} ${r.integration.name} ${r.rule ?? ""} ${r.id}`.toLowerCase().includes(ql)),
    );
    const val = (r: Row) => (sort.key === "risk" ? r.risk.score : sort.key === "received_at" ? r.received_at : sort.key === "title" ? r.title : r.final_status);
    return out.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [rows, q, status, integration, actor, risk, sort]);

  const exportCsv = () => {
    const head = "id,received_at,title,actor,integration,status,risk_level,risk_score,rule,outcome";
    const body = filtered.map((r) => [r.id, r.received_at, r.title, r.actor.name, r.integration.name, r.final_status, r.risk.level, r.risk.score, r.rule ?? "", r.outcome ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[head, ...body].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `orbis-actions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const th = (key: SortKey, label: string, cls = "") => (
    <th className={cn("px-3 py-2.5 font-medium", cls)} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : -1 }))}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );
  const sel = "h-9 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[13px] text-ink-2 shadow-card outline-none focus:border-cobalt";

  return (
    <div className={cn("grid gap-0", selected && "xl:grid-cols-[1fr_440px]")}>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, actor, rule, id…" className={cn(inputCls, "h-9 pl-9")} aria-label="Search actions" />
          </div>
          <select className={sel} value={integration} onChange={(e) => setIntegration(e.target.value)} aria-label="Integration">
            <option value="">All integrations</option>
            {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <select className={sel} value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Actor">
            <option value="">All actors</option>
            {actors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <select className={sel} value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="Risk">
            <option value="">Any risk</option>
            {["low", "medium", "high", "critical"].map((l) => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
          </select>
          <Button size="sm" variant="secondary" onClick={exportCsv} className="h-9"><Download className="size-4" /> CSV</Button>
        </div>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => {
            const n = s === "all" ? rows.length : rows.filter((r) => r.final_status === s).length;
            return (
              <button key={s} onClick={() => setStatus(s)} className={cn("rounded-full px-3 py-1 text-[12.5px] font-medium ring-1 ring-inset transition", status === s ? "bg-ink text-white ring-ink" : "bg-surface text-ink-2 ring-line hover:ring-line-strong")}>
                {s === "all" ? "All" : s.replace("_", " ").replace(/^\w/, (c) => c.toUpperCase())} <span className="tnum opacity-60">{n}</span>
              </button>
            );
          })}
        </div>

        <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13.5px]">
              <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  {th("title", "Action", "pl-4")}
                  {th("final_status", "Decision")}
                  {th("risk", "Risk")}
                  <th className="px-3 py-2.5 font-medium">Rule</th>
                  <th className="px-3 py-2.5 font-medium">Outcome</th>
                  {th("received_at", "When", "pr-4 text-right")}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.slice(0, limit).map((r) => (
                  <tr key={r.id} onClick={() => select(r.id)} className={cn("cursor-pointer transition", selected === r.id ? "bg-cobalt-50/60" : "hover:bg-surface-2/50")} aria-selected={selected === r.id}>
                    <td className="py-2.5 pl-4 pr-3">
                      <div className="font-medium">{r.title}{r.amount_usd ? <span className="tnum ml-1.5 text-[12px] font-normal text-muted">{usd(r.amount_usd, true)}</span> : null}</div>
                      <div className="text-[12px] text-muted">{r.actor.name} · {r.integration.name}</div>
                    </td>
                    <td className="px-3 py-2.5"><StatusBadge status={r.mode === "observe" ? "observe" : r.final_status} /></td>
                    <td className="px-3 py-2.5"><RiskBadge level={r.risk.level} score={r.risk.score} /></td>
                    <td className="max-w-[220px] truncate px-3 py-2.5 text-[12.5px] text-muted">{r.rule ?? "—"}</td>
                    <td className="px-3 py-2.5 text-[12.5px] capitalize text-ink-2">{r.outcome?.replace("_", " ") ?? "—"}</td>
                    <td className="whitespace-nowrap py-2.5 pl-3 pr-4 text-right text-[12px] text-muted"><RelTime iso={r.received_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && <EmptyState icon={SearchX} title="No actions match" body="Clear a filter or widen the search. Every request that reaches the gateway is recorded here." action={<Button size="sm" onClick={() => { setQ(""); setStatus("all"); setIntegration(""); setActor(""); setRisk(""); }}>Clear filters</Button>} />}
          {filtered.length > limit && (
            <div className="border-t border-line px-4 py-3 text-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 120)}>Show more · {filtered.length - limit} remaining</Button>
            </div>
          )}
        </div>
      </div>
      {selected && (
        <div className="fixed inset-0 z-40 xl:static xl:z-auto xl:ml-4">
          <div className="absolute inset-0 bg-ink/20 xl:hidden" onClick={() => select(null)} />
          <div className="absolute inset-y-0 right-0 w-full max-w-[460px] xl:sticky xl:top-20 xl:h-[calc(100vh-7rem)] xl:max-w-none xl:overflow-hidden xl:rounded-[var(--radius-card)] xl:border xl:border-line xl:shadow-card">
            <ActionInspector key={selected} id={selected} onClose={() => select(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
