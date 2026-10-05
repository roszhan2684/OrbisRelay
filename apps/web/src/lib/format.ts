// Client-safe formatting helpers.
export const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

export function usd(n: number | null | undefined, compact = false) {
  if (n === null || n === undefined) return "—";
  if (compact && Math.abs(n) >= 1000) {
    return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)}`;
  }
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export const num = (n: number, compact = false) =>
  compact ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n) : n.toLocaleString("en-US");

export function duration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  return `${h}h ${Math.round((seconds % 3600) / 60)}m`;
}

export function ago(iso: string, now = Date.now()) {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 0) return `in ${duration(-s)}`;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function until(iso: string, now = Date.now()) {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

// Fixed to the tenant timezone so server-rendered and hydrated text always match.
export const TENANT_TZ = "America/New_York";

export function dateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TENANT_TZ });
}

export function shortDate(iso: string) {
  return new Date(iso + (iso.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export const STATUS_LABEL: Record<string, string> = {
  allow: "Allowed",
  warn: "Allowed · warned",
  deny: "Denied",
  pending: "Awaiting human",
  approved: "Approved",
  approved_modified: "Approved · modified",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
  approval_required: "Approval required",
};

export const ROUTE_LABEL: Record<string, string> = {
  security: "Security",
  "ai-governance": "AI governance",
  "finance-controller": "Finance controllers",
  "support-manager": "Support managers",
  "eng-oncall": "Engineering on-call",
  "eng-manager": "Engineering managers",
  "data-owner": "Data owner + Security",
  "sales-leader": "Sales leadership",
  privacy: "Privacy office",
  "facility-ops": "Facility operations",
};
