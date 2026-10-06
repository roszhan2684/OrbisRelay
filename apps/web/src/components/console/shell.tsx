"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  BarChart3,
  Boxes,
  BrainCircuit,
  Code2,
  FileClock,
  Gauge,
  Inbox,
  LogOut,
  Menu,
  RotateCcw,
  ScanSearch,
  Settings,
  ShieldCheck,
  Smartphone,
  Snowflake,
  Users2,
  X,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Wordmark } from "@/components/logo";
import { Avatar, Badge } from "@/components/ui";
import { cn } from "@/lib/format";
import { api, LiveDot } from "./live";
import { PhoneTwin } from "./phone-twin";

const NAV = [
  { href: "/console", label: "Overview", icon: Gauge },
  { href: "/console/actions", label: "Actions", icon: Activity },
  { href: "/console/approvals", label: "Approvals", icon: Inbox, countKey: "pending" },
  { href: "/console/policies", label: "Policies", icon: ShieldCheck },
  { href: "/console/integrations", label: "Integrations", icon: Boxes },
  { href: "/console/actors", label: "Agents & Actors", icon: Users2 },
  { href: "/console/intelligence", label: "Intelligence", icon: BrainCircuit },
  { href: "/console/audit", label: "Audit", icon: FileClock },
  { href: "/console/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/console/protect", label: "Protect", icon: ScanSearch },
  { href: "/console/developer", label: "Developer", icon: Code2 },
  { href: "/console/settings", label: "Settings", icon: Settings },
] as const;

export interface ShellProps {
  user: { name: string; email: string; title: string; color: string };
  tenant: { name: string; plan: string };
  pending: number;
  freezes: Array<{ actor_id: string; actor_name: string; reason: string; by: string; at: string; blocked: number }>;
  children: React.ReactNode;
}

export function ConsoleShell({ user, tenant, pending, freezes, children }: ShellProps) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [phone, setPhone] = React.useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Console">
      {NAV.map((n) => {
        const active = n.href === "/console" ? path === "/console" : path.startsWith(n.href);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[13.5px] font-medium transition",
              active ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-2 hover:bg-surface-3/60 hover:text-ink",
            )}
          >
            <Icon className={cn("size-[17px]", active ? "text-cobalt" : "text-muted group-hover:text-ink-2")} />
            <span className="flex-1">{n.label}</span>
            {"countKey" in n && pending > 0 && <span className="tnum rounded-full bg-cobalt px-1.5 py-px text-[11px] font-semibold text-white">{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-5 px-3 py-4">
      <div className="flex items-center justify-between px-1.5">
        <Link href="/" aria-label="Orbis Relay home">
          <Wordmark />
        </Link>
      </div>
      <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-faint">Tenant</div>
        <div className="mt-0.5 flex items-center justify-between">
          <span className="text-[13.5px] font-semibold">{tenant.name}</span>
          <Badge tone="cobalt">{tenant.plan}</Badge>
        </div>
      </div>
      {nav}
      <div className="mt-auto space-y-2">
        <Link href="/demo" className="flex items-center justify-between rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-[13px] text-ink-2 hover:border-cobalt hover:text-cobalt">
          Open Northstar demo app <ExternalLink className="size-3.5" />
        </Link>
        <p className="px-1 text-[11px] leading-snug text-faint">Demo tenant · data is seeded and resets every 20h.</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-page">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-line bg-page lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal>
          <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[264px] border-r border-line bg-page shadow-pop">
            <button className="absolute right-3 top-4 rounded-lg p-1.5 hover:bg-surface-2" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className={cn("lg:pl-[248px] transition-[padding] duration-300", phone && "xl:pr-[400px]")}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-page/85 px-4 backdrop-blur-md sm:px-6">
          <button className="rounded-lg p-1.5 hover:bg-surface-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <LiveDot />
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setPhone((p) => !p)}
              className={cn("flex h-9 items-center gap-2 rounded-[10px] border px-3 text-[13px] font-medium transition", phone ? "border-cobalt bg-cobalt-50 text-cobalt-700" : "border-line-strong bg-surface text-ink-2 hover:bg-surface-2")}
              aria-pressed={phone}
            >
              <Smartphone className="size-4" />
              <span className="hidden sm:inline">iPhone twin</span>
              {pending > 0 && <span className="tnum rounded-full bg-cobalt px-1.5 text-[11px] font-semibold text-white">{pending}</span>}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="flex items-center gap-2 rounded-[10px] py-1 pl-1 pr-2 hover:bg-surface-2" aria-label="Account menu">
                <Avatar name={user.name} color={user.color} />
                <span className="hidden text-left leading-tight md:block">
                  <span className="block text-[13px] font-semibold">{user.name}</span>
                  <span className="block text-[11px] text-muted">{user.title}</span>
                </span>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-xl border border-line bg-surface p-1 shadow-pop">
                  <div className="px-2.5 py-2 text-[12px] text-muted">{user.email}</div>
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-2"
                    onSelect={async () => {
                      await api("/api/v1/demo/reset", { method: "POST" });
                      router.refresh();
                    }}
                  >
                    <RotateCcw className="size-4 text-muted" /> Reset demo data
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-2"
                    onSelect={async () => {
                      await api("/api/auth/signout", { method: "POST" });
                      toast("Signed out");
                      router.push("/signin");
                    }}
                  >
                    <LogOut className="size-4 text-muted" /> Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        {freezes.length > 0 && (
          <div role="status" className="border-b border-critical/20 bg-critical-bg px-4 py-2.5 sm:px-6">
            {freezes.map((f) => (
              <div key={f.actor_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-critical">
                <span className="flex items-center gap-1.5 font-semibold">
                  <Snowflake className="size-4" /> {f.actor_name} is frozen
                </span>
                <span className="text-ink-2">
                  {f.reason} · by {f.by} · {f.blocked} request{f.blocked === 1 ? "" : "s"} blocked
                </span>
                <Link href="/console/actors" className="ml-auto font-medium underline underline-offset-2">
                  Review freeze
                </Link>
              </div>
            ))}
          </div>
        )}

        <main className="mx-auto max-w-[1360px] px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>

      <PhoneTwin open={phone} onClose={() => setPhone(false)} />
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-cobalt">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[14px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
