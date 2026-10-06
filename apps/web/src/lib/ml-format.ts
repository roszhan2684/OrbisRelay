// Pure formatting helpers shared by server and client Intelligence views.
export const LABELS = ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"] as const;
export const LABEL_TEXT: Record<string, string> = { safe_normal: "Safe · normal", safe_unusual: "Safe · unusual", suspicious_review: "Suspicious", high_risk: "High risk" };
export const LABEL_TONE: Record<string, "low" | "medium" | "high" | "critical" | "neutral"> = { safe_normal: "low", safe_unusual: "neutral", suspicious_review: "high", high_risk: "critical" };
export const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
