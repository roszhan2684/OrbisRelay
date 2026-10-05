import { cn } from "@/lib/format";

/** Orbis mark: an orbit with a relay node — the gate between intent and execution. */
export function OrbisMark({ className, light }: { className?: string; light?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill={light ? "#ffffff" : "#0b1220"} />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke={light ? "#0b1220" : "#ffffff"} strokeOpacity="0.9" strokeWidth="2" />
      <path d="M7.5 16h4.2" stroke={light ? "#0b1220" : "#fff"} strokeWidth="2" strokeLinecap="round" />
      <circle cx="21.6" cy="10.4" r="3.2" fill="#2747e8" stroke={light ? "#ffffff" : "#0b1220"} strokeWidth="1.6" />
    </svg>
  );
}

export function Wordmark({ className, light }: { className?: string; light?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <OrbisMark light={light} />
      <span className={cn("text-[17px] font-semibold tracking-[-0.02em]", light ? "text-white" : "text-ink")}>
        Orbis <span className={light ? "text-white/60" : "text-muted"}>Relay</span>
      </span>
    </span>
  );
}
