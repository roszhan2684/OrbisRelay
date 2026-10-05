"use client";
import { ago, until } from "@/lib/format";
import { useNow } from "./live";

export function Countdown({ to, className }: { to: string; className?: string }) {
  const now = useNow();
  const left = new Date(to).getTime() - now;
  return (
    <span className={`tnum ${left < 15 * 60_000 ? "font-semibold text-critical" : ""} ${className ?? ""}`} suppressHydrationWarning>
      {left <= 0 ? "expired" : `${until(to, now)} left`}
    </span>
  );
}

export function RelTime({ iso, className }: { iso: string; className?: string }) {
  const now = useNow(15_000);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className={className} suppressHydrationWarning>
      {ago(iso, now)}
    </time>
  );
}
