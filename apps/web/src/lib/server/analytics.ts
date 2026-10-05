import "server-only";
import type { ActionRecord, DB } from "../domain";

const DAY = 86_400_000;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};

export const HUMAN = new Set(["pending", "approved", "approved_modified", "rejected", "expired", "cancelled"]);
export const AUTO = new Set(["allow", "warn"]);

export function category(a: ActionRecord): "auto" | "human" | "blocked" {
  if (a.final_status === "deny") return "blocked";
  if (HUMAN.has(a.final_status)) return "human";
  return "auto";
}

export function computeAnalytics(db: DB, days = 28, now = new Date()) {
  const since = now.getTime() - days * DAY;
  const acts = db.actions.filter((a) => new Date(a.received_at).getTime() >= since);
  const enforced = acts.filter((a) => a.mode === "enforce");
  const week = enforced.filter((a) => new Date(a.received_at).getTime() >= now.getTime() - 7 * DAY);
  const prevWeek = enforced.filter((a) => {
    const t = new Date(a.received_at).getTime();
    return t < now.getTime() - 7 * DAY && t >= now.getTime() - 14 * DAY;
  });

  const auto = enforced.filter((a) => AUTO.has(a.final_status)).length;
  const human = enforced.filter((a) => HUMAN.has(a.final_status)).length;
  const blocked = enforced.filter((a) => a.final_status === "deny").length;

  const approvals = db.approvals.filter((p) => new Date(p.created_at).getTime() >= since);
  const resolved = approvals.filter((p) => p.resolved_at && ["approved", "approved_modified", "rejected"].includes(p.status));
  const latencies = resolved.map((p) => (new Date(p.resolved_at!).getTime() - new Date(p.created_at).getTime()) / 1000);
  const unnecessary = resolved.filter((p) => p.responses.some((r) => r.unnecessary)).length;
  const redirected = resolved.filter((p) => p.responses.some((r) => r.decision === "safe_alternative")).length;
  const modified = resolved.filter((p) => p.status === "approved_modified").length;

  // Daily series
  const series: Array<{ date: string; auto: number; human: number; blocked: number; observed: number }> = [];
  for (let d = days - 1; d >= 0; d--) {
    const start = new Date(now.getTime() - d * DAY);
    start.setUTCHours(0, 0, 0, 0);
    const end = start.getTime() + DAY;
    const dayActs = acts.filter((a) => {
      const t = new Date(a.received_at).getTime();
      return t >= start.getTime() && t < end;
    });
    series.push({
      date: start.toISOString().slice(0, 10),
      auto: dayActs.filter((a) => a.mode === "enforce" && category(a) === "auto").length,
      human: dayActs.filter((a) => a.mode === "enforce" && category(a) === "human").length,
      blocked: dayActs.filter((a) => a.mode === "enforce" && category(a) === "blocked").length,
      observed: dayActs.filter((a) => a.mode === "observe").length,
    });
  }

  const riskMix = (["low", "medium", "high", "critical"] as const).map((level) => ({ level, count: enforced.filter((a) => a.evaluation.risk.level === level).length }));

  const blockedBy = new Map<string, { rule: string; policy: string; count: number }>();
  for (const a of enforced.filter((x) => x.final_status === "deny" || x.final_status === "rejected")) {
    const key = a.evaluation.deciding?.rule_name ?? "Rejected by approver";
    const cur = blockedBy.get(key) ?? { rule: key, policy: a.evaluation.deciding?.policy_name ?? "—", count: 0 };
    cur.count += 1;
    blockedBy.set(key, cur);
  }

  const approverStats = db.users
    .map((u) => {
      const rs = approvals.flatMap((p) => p.responses.filter((r) => r.user_id === u.id).map((r) => (new Date(r.responded_at).getTime() - new Date(p.created_at).getTime()) / 1000));
      return { user_id: u.id, name: u.name, title: u.title, responses: rs.length, median_s: Math.round(quantile(rs, 0.5)), p95_s: Math.round(quantile(rs, 0.95)) };
    })
    .filter((x) => x.responses > 0)
    .sort((a, b) => b.responses - a.responses);

  const actorStats = db.actors
    .filter((a) => a.id !== "sandbox-agent")
    .map((actor) => {
      const mine = acts.filter((a) => a.envelope.actor.id === actor.id);
      const hourly = Array.from({ length: 48 }, (_, h) => {
        const end = now.getTime() - (47 - h) * 3_600_000;
        return mine.filter((a) => {
          const t = new Date(a.received_at).getTime();
          return t > end - 3_600_000 && t <= end;
        }).length;
      });
      return {
        id: actor.id,
        name: actor.name,
        type: actor.type,
        total: mine.length,
        human: mine.filter((a) => HUMAN.has(a.final_status)).length,
        blocked: mine.filter((a) => a.final_status === "deny").length,
        anomalies: mine.filter((a) => a.envelope.signals?.actor_anomaly).length,
        frozen: db.freezes.some((f) => f.actor_id === actor.id && !f.lifted_at),
        hourly,
      };
    })
    .sort((a, b) => b.total - a.total);

  const prevented = enforced.filter((a) => ["deny", "rejected", "approved_modified"].includes(a.final_status));
  const moneyProtected = prevented.reduce((s, a) => {
    const amt = Number(a.envelope.business_context?.amount_usd ?? 0);
    if (a.final_status === "approved_modified" && a.approved_parameters?.amount_usd !== undefined) return s + Math.max(0, amt - Number(a.approved_parameters.amount_usd));
    return s + (a.final_status === "approved_modified" ? 0 : amt);
  }, 0);
  const recordsProtected = prevented.reduce((s, a) => s + Number(a.envelope.business_context?.record_count ?? 0), 0);

  const seenTypes = [...new Set(enforced.map((a) => a.envelope.action.type))];
  const covered = seenTypes.filter((t) => enforced.some((a) => a.envelope.action.type === t && a.evaluation.matched.length > 0));

  const activation = db.integrations
    .filter((i) => i.first_protected_at && i.kind !== "sandbox")
    .map((i) => ({ id: i.id, name: i.name, minutes: Math.round((new Date(i.first_protected_at!).getTime() - new Date(i.created_at).getTime()) / 60_000) }));

  return {
    window_days: days,
    totals: { actions: enforced.length, auto, human, blocked, observed: acts.length - enforced.length },
    paw: { current: week.length, previous: prevWeek.length },
    autonomy_retained: pct(auto, enforced.length),
    human_rate: pct(human, enforced.length),
    approval_latency: { mean_s: Math.round(latencies.reduce((s, x) => s + x, 0) / Math.max(latencies.length, 1)), median_s: Math.round(quantile(latencies, 0.5)), p95_s: Math.round(quantile(latencies, 0.95)) },
    false_friction: pct(unnecessary, resolved.length),
    safe_redirect_rate: pct(redirected, resolved.length),
    modified_rate: pct(modified, resolved.length),
    expired: approvals.filter((p) => p.status === "expired").length,
    policy_coverage: { pct: pct(covered.length, seenTypes.length), covered: covered.length, total: seenTypes.length, uncovered: seenTypes.filter((t) => !covered.includes(t)) },
    activation,
    series,
    risk_mix: riskMix,
    top_blocked: [...blockedBy.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    approvers: approverStats,
    actors: actorStats,
    impact: { money_protected_usd: moneyProtected, records_protected: recordsProtected, incidents_avoided: prevented.filter((a) => a.evaluation.risk.level === "high" || a.evaluation.risk.level === "critical").length },
  };
}

export type Analytics = ReturnType<typeof computeAnalytics>;
