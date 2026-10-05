"use client";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

type LiveEvent = { type: string; title?: string; risk?: string; status?: string; actor_id?: string; frozen?: boolean; verdict?: string; approval_id?: string };

const LiveContext = React.createContext<{ connected: boolean; last?: LiveEvent; subscribe: (fn: (e: LiveEvent) => void) => () => void }>({
  connected: false,
  subscribe: () => () => {},
});
export const useLive = () => React.useContext(LiveContext);

/** Subscribes to /api/v1/stream; refreshes server components when data changes. */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [connected, setConnected] = React.useState(false);
  const [last, setLast] = React.useState<LiveEvent>();
  const subs = React.useRef(new Set<(e: LiveEvent) => void>());
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      es = new EventSource("/api/v1/stream");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(open, 3000);
      };
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as LiveEvent;
        if (e.type === "hello" || e.type === "ping") return;
        setLast(e);
        subs.current.forEach((fn) => fn(e));
        if (e.type === "approval.created") toast(`Action paused — ${e.title}`, { description: `${e.risk} risk · routed for human approval` });
        if (e.type === "freeze.changed") toast(e.frozen ? `Actor frozen: ${e.actor_id}` : `Actor restored: ${e.actor_id}`);
        if (e.type === "demo.reset") toast("Demo data reset");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 350);
      };
    };
    open();
    return () => {
      es?.close();
      clearTimeout(retry);
    };
  }, [router]);

  const subscribe = React.useCallback((fn: (e: LiveEvent) => void) => {
    subs.current.add(fn);
    return () => {
      subs.current.delete(fn);
    };
  }, []);

  return <LiveContext.Provider value={{ connected, last, subscribe }}>{children}</LiveContext.Provider>;
}

export function LiveDot() {
  const { connected } = useLive();
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted" aria-live="polite">
      <span className={`size-2 rounded-full ${connected ? "bg-low animate-pulse" : "bg-faint"}`} />
      {connected ? "Live" : "Reconnecting"}
    </span>
  );
}

/** Ticks every second for countdowns. */
export function useNow(interval = 1000) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`) as Error & { code?: string; status?: number; remediation?: string };
    err.code = data?.error?.code;
    err.status = res.status;
    err.remediation = data?.error?.remediation;
    throw err;
  }
  return data as T;
}
