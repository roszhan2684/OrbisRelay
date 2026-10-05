"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ArrowRight, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/logo";
import { Avatar, Button } from "@/components/ui";
import { api } from "@/components/console/live";

export function SignInCard({ personas, next }: { personas: Array<{ email: string; name: string; title: string; color: string; roles: string[] }>; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const go = async (email: string) => {
    setBusy(email);
    try {
      await api("/api/auth/signin", { method: "POST", json: { email } });
      router.push(next);
      router.refresh();
    } catch {
      setBusy(null);
    }
  };
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-night text-white lg:block">
        <div className="night-grid absolute inset-0" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Link href="/"><Wordmark light /></Link>
          <div>
            <p className="font-serif text-[44px] italic leading-[1.05] tracking-[-0.01em] text-white/95">“Control without<br />killing autonomy.”</p>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/60">The console is where policies are written, integrations are debugged and every decision is explained after the fact.</p>
          </div>
          <div className="flex items-center gap-2 text-[13px] text-white/50"><ShieldCheck className="size-4" /> SSO · least-privilege RBAC · every sign-in is audited</div>
        </div>
      </div>
      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-[400px]">
          <div className="lg:hidden"><Wordmark /></div>
          <h1 className="mt-8 text-[28px] font-semibold tracking-[-0.025em] lg:mt-0">Sign in to Northstar Cloud</h1>
          <p className="mt-1.5 text-[14px] text-muted">Demo tenant. Choose a persona — each sees what their role allows.</p>
          <Button variant="primary" size="lg" className="mt-6 w-full" onClick={() => go("alex.chen@northstar.cloud")} disabled={!!busy}>
            {busy === "alex.chen@northstar.cloud" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Continue with Okta SSO
          </Button>
          <div className="my-6 flex items-center gap-3 text-[12px] text-faint"><span className="h-px flex-1 bg-line" /> or pick a persona <span className="h-px flex-1 bg-line" /></div>
          <ul className="space-y-2">
            {personas.map((p) => (
              <li key={p.email}>
                <button onClick={() => go(p.email)} disabled={!!busy} className="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left shadow-card transition hover:border-cobalt/40 hover:bg-cobalt-50/40">
                  <Avatar name={p.name} color={p.color} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold">{p.name}</span>
                    <span className="block truncate text-[12px] text-muted">{p.title} · {p.roles.slice(0, 3).join(", ")}</span>
                  </span>
                  {busy === p.email ? <Loader2 className="size-4 animate-spin text-cobalt" /> : <ArrowRight className="size-4 text-faint transition group-hover:translate-x-0.5 group-hover:text-cobalt" />}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-center text-[12px] text-faint">Production tenants use OIDC/SAML; this demo issues a session for the chosen persona.</p>
        </div>
      </div>
    </div>
  );
}
