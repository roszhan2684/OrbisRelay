"use client";
import { useRouter } from "next/navigation";
import * as React from "react";
import * as Switch from "@radix-ui/react-switch";
import { Smartphone, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import type { Device, Tenant, User } from "@/lib/domain";
import { api } from "@/components/console/live";
import { RelTime } from "@/components/console/time";
import { Avatar, Badge, Button, Card, CardHeader } from "@/components/ui";
import { Meter } from "@/components/charts";
import { cn } from "@/lib/format";

const ROLE_MATRIX: Array<[string, string[]]> = [
  ["View decisions & audit", ["owner", "admin", "auditor", "policy_admin"]],
  ["Approve assigned actions", ["approver", "owner", "admin"]],
  ["Draft & simulate policy", ["policy_admin", "owner"]],
  ["Publish policy (with 2nd admin)", ["policy_admin", "owner"]],
  ["Freeze actors", ["responder", "admin", "owner"]],
  ["Lift a freeze", ["admin", "owner"]],
  ["Manage keys & webhooks", ["developer", "admin", "owner"]],
  ["Tenant settings", ["admin", "owner"]],
];
const ROLES = ["owner", "admin", "policy_admin", "approver", "responder", "developer", "auditor"];

export function SettingsView({ tenant, users, devices }: { tenant: Tenant; users: User[]; devices: Array<Device & { user_name: string }> }) {
  const router = useRouter();
  const patch = async (body: Record<string, unknown>) => {
    try {
      await api("/api/v1/settings", { method: "PATCH", json: body });
      toast.success("Saved · change recorded in the audit trail");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const s = tenant.settings;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Tenant" />
        <dl className="divide-y divide-line text-[13.5px]">
          {[
            ["Organization", tenant.name],
            ["Tenant ID", <span key="t" className="font-mono text-[12.5px]">{tenant.id}</span>],
            ["Data region", s.data_region],
            ["Timezone / business hours", `${s.timezone} · ${s.business_hours.start}:00–${s.business_hours.end}:00`],
            ["SSO", <span key="s" className="flex items-center gap-2">{s.sso.provider} <Badge tone="low">Enforced for @{s.sso.domain}</Badge></span>],
          ].map(([k, v]) => (
            <div key={String(k)} className="grid grid-cols-[200px_1fr] gap-3 px-5 py-3"><dt className="text-muted">{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </Card>

      <Card>
        <CardHeader title="Security & privacy controls" />
        <div className="divide-y divide-line">
          <Toggle label="Second admin required to publish policy" hint="Enterprise control: a different policy admin co-signs every publish." checked={s.policy_publish_requires_second_approver} onChange={(v) => patch({ policy_publish_requires_second_approver: v })} />
          <Toggle label="Metadata-only mode" hint="Reject envelopes that include free-text evidence; callers send classifications and counts only." checked={s.metadata_only_mode} onChange={(v) => patch({ metadata_only_mode: v })} />
          <Toggle label="SCIM provisioning" hint="Sync users and groups from Okta. Approver routes follow group membership." checked={s.scim} onChange={(v) => patch({ scim: v })} />
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <div><div className="text-[14px] font-medium">Push notification content</div><div className="text-[12.5px] text-muted">Push never carries sensitive payloads — only a summary and a deep link.</div></div>
            <select value={s.notification_policy} onChange={(e) => patch({ notification_policy: e.target.value })} className="h-9 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[13px]" aria-label="Notification content">
              <option value="minimal_summary">Title + risk level</option>
              <option value="title_only">“Action needs approval” only</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <div><div className="text-[14px] font-medium">Decision & audit retention</div><div className="text-[12.5px] text-muted">Receipts and audit events older than this are exported, then deleted.</div></div>
            <select value={tenant.retention_days} onChange={(e) => patch({ retention_days: Number(e.target.value) })} className="h-9 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[13px]" aria-label="Retention">
              <option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option><option value={2555}>7 years</option>
            </select>
          </div>
        </div>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader title="Roles & permissions" description="Least-privilege RBAC. Client UI state is never authority — every action is re-checked server-side." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="border-b border-line text-[12px] text-muted"><tr><th className="px-5 py-2 text-left font-medium">Capability</th>{ROLES.map((r) => <th key={r} className="px-2 py-2 font-medium capitalize">{r.replace("_", " ")}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {ROLE_MATRIX.map(([cap, roles]) => (
                <tr key={cap}><td className="px-5 py-2">{cap}</td>{ROLES.map((r) => <td key={r} className="px-2 py-2 text-center">{roles.includes(r) ? <span className="text-low" aria-label="allowed">●</span> : <span className="text-line-strong" aria-label="not allowed">○</span>}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title={`Members · ${users.length}`} />
        <ul className="divide-y divide-line">
          {users.map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-5 py-2.5">
              <Avatar name={u.name} color={u.color} size={30} />
              <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{u.name}</div><div className="truncate text-[12px] text-muted">{u.title} · {u.email}</div></div>
              <div className="hidden max-w-[220px] flex-wrap justify-end gap-1 sm:flex">{u.roles.slice(0, 3).map((r) => <Badge key={r} tone="neutral" className="capitalize">{r.replace("_", " ")}</Badge>)}{u.roles.length > 3 && <Badge tone="neutral">+{u.roles.length - 3}</Badge>}</div>
            </li>
          ))}
        </ul>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Registered devices" description="Server-side revocation ends sessions and rejects step-up from that phone" />
          <ul className="divide-y divide-line">
            {devices.map((d) => (
              <li key={d.id} className={cn("flex items-center gap-3 px-5 py-2.5 text-[13px]", d.trust === "revoked" && "opacity-55")}>
                <Smartphone className="size-4 text-muted" />
                <div className="min-w-0 flex-1"><div className="font-medium">{d.name} <span className="font-normal text-muted">· {d.model} · {d.os}</span></div><div className="text-[12px] text-muted">{d.user_name} · seen <RelTime iso={d.last_seen_at} /> · Face ID</div></div>
                {d.trust === "revoked" ? <Badge tone="neutral">Revoked</Badge> : <><Badge tone={d.trust === "managed" ? "cobalt" : "neutral"}>{d.trust === "managed" ? "MDM managed" : "Registered"}</Badge><Button size="sm" variant="ghost" className="!text-critical" onClick={async () => { await api(`/api/v1/devices/${d.id}/revoke`, { method: "POST" }); toast.success(`${d.name} revoked`); router.refresh(); }}><ShieldOff className="size-4" /></Button></>}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Plan & usage" description={`${tenant.plan} · platform fee + decision volume (never per approver)`} />
          <div className="p-5">
            <div className="flex items-baseline justify-between text-[13.5px]"><span>Decisions this month</span><span className="tnum font-semibold">{tenant.usage.decisions_this_month.toLocaleString("en-US")} / {tenant.usage.included_decisions.toLocaleString("en-US")}</span></div>
            <div className="mt-2"><Meter value={tenant.usage.decisions_this_month} max={tenant.usage.included_decisions} /></div>
            <p className="mt-2 text-[12px] text-muted">Metering is computed after enforcement and can never change a decision.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div><div className="text-[14px] font-medium">{label}</div><div className="text-[12.5px] text-muted">{hint}</div></div>
      <Switch.Root checked={checked} onCheckedChange={onChange} className="relative h-6 w-10 shrink-0 rounded-full bg-line-strong transition data-[state=checked]:bg-cobalt" aria-label={label}>
        <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition data-[state=checked]:translate-x-[18px]" />
      </Switch.Root>
    </div>
  );
}
