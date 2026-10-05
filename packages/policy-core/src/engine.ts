import {
  EFFECT_SEVERITY,
  type ActionEnvelope,
  type Classification,
  type Condition,
  type Effect,
  type Evaluation,
  type EvaluationContext,
  type Facts,
  type FactValue,
  type MatchedRule,
  type Policy,
  type PolicyRule,
  type PolicyVersion,
  type RiskAssessment,
  type RiskLevel,
  type RiskReason,
} from "./types";

const CLASSIFICATION_RANK: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
  regulated: 4,
};

const EXTERNAL_DESTINATIONS = new Set(["external_domain", "external_model", "beneficiary", "partner", "customer"]);

/**
 * Flatten an action envelope into the fact namespace that policy conditions match on.
 * Everything here is deterministic: same envelope + context => same facts.
 */
export function deriveFacts(env: ActionEnvelope, ctx: EvaluationContext): Facts {
  const resources = env.resources ?? [];
  let maxClass: Classification | undefined;
  let resourceCount = 0;
  let environment: string | undefined;
  for (const r of resources) {
    if (r.classification && (!maxClass || CLASSIFICATION_RANK[r.classification] > CLASSIFICATION_RANK[maxClass])) {
      maxClass = r.classification;
    }
    resourceCount += r.count ?? 1;
    if (r.environment === "production" || (!environment && r.environment)) environment = r.environment;
  }

  const dest = env.destination;
  const destValue = dest?.value?.toLowerCase();
  const destApproved = destValue ? ctx.approvedDestinations.has(destValue) : undefined;
  const destKnown = destValue ? (ctx.knownDestinations ? ctx.knownDestinations.has(destValue) : true) : undefined;
  const external = dest ? EXTERNAL_DESTINATIONS.has(dest.type) : false;

  const bh = ctx.businessHours ?? { start: 8, end: 19, timezoneOffsetMinutes: 0 };
  const local = new Date(ctx.now.getTime() + bh.timezoneOffsetMinutes * 60_000);
  const hour = local.getUTCHours();
  const day = local.getUTCDay();
  const businessHours = day >= 1 && day <= 5 && hour >= bh.start && hour < bh.end;

  const bc = env.business_context ?? {};
  const reason = env.intent?.reason?.trim() ?? "";

  return {
    "actor.type": env.actor.type,
    "actor.id": env.actor.id,
    "actor.owner": env.actor.owner,
    "actor.trust": ctx.actorTrust?.[env.actor.id] ?? "trusted",
    "actor.frozen": ctx.frozenActors.has(env.actor.id),
    "action.type": env.action.type,
    "action.tool": env.action.tool,
    "resource.classification": maxClass,
    "resource.classification_rank": maxClass ? CLASSIFICATION_RANK[maxClass] : 0,
    "resource.count": resourceCount,
    "resource.type": resources[0]?.type,
    "resource.environment": environment,
    "destination.type": dest?.type,
    "destination.value": destValue,
    "destination.external": external,
    "destination.approved": destApproved,
    "destination.new": destKnown === undefined ? undefined : !destKnown || env.signals?.new_destination === true,
    amount_usd: typeof bc.amount_usd === "number" ? bc.amount_usd : undefined,
    record_count: typeof bc.record_count === "number" ? bc.record_count : undefined,
    duration_minutes: typeof bc.duration_minutes === "number" ? bc.duration_minutes : undefined,
    "context.incident_active": env.signals?.incident_active === true || !!bc.incident_id,
    "context.change_request": typeof bc.change_request === "string" ? bc.change_request : undefined,
    "context.ticket": typeof bc.ticket === "string" ? bc.ticket : undefined,
    "context.justified": reason.length >= 12,
    "signals.actor_anomaly": env.signals?.actor_anomaly === true,
    "signals.outside_change_window": env.signals?.outside_change_window === true,
    "signals.tests_passed": env.signals?.tests_passed,
    "signals.fraud_signal": env.signals?.fraud_signal === true,
    "time.business_hours": businessHours,
    "time.hour": hour,
  };
}

function compare(fact: FactValue, cond: Condition): boolean {
  const v = cond.value;
  switch (cond.op) {
    case "exists":
      return fact !== undefined && fact !== null && fact !== "";
    case "not_exists":
      return fact === undefined || fact === null || fact === "";
    case "eq":
      return fact === v;
    case "neq":
      return fact !== v;
    case "in":
      return Array.isArray(v) && fact !== undefined && (v as Array<string | number>).includes(fact as string | number);
    case "not_in":
      return Array.isArray(v) && (fact === undefined || !(v as Array<string | number>).includes(fact as string | number));
    case "gt":
      return typeof fact === "number" && typeof v === "number" && fact > v;
    case "gte":
      return typeof fact === "number" && typeof v === "number" && fact >= v;
    case "lt":
      return typeof fact === "number" && typeof v === "number" && fact < v;
    case "lte":
      return typeof fact === "number" && typeof v === "number" && fact <= v;
    case "contains":
      return typeof fact === "string" && typeof v === "string" && fact.toLowerCase().includes(v.toLowerCase());
  }
}

export function ruleMatches(rule: PolicyRule, facts: Facts): boolean {
  const all = rule.when.all ?? [];
  const any = rule.when.any ?? [];
  if (all.length === 0 && any.length === 0) return false;
  const allOk = all.every((c) => compare(facts[c.field], c));
  const anyOk = any.length === 0 || any.some((c) => compare(facts[c.field], c));
  return allOk && anyOk;
}

/**
 * Illustrative contextual risk score (blueprint §8.3). Used for prioritisation and routing only;
 * hard policy decides enforcement.
 */
export function scoreRisk(facts: Facts): RiskAssessment {
  const reasons: RiskReason[] = [];
  const add = (code: string, label: string, weight: number) => reasons.push({ code, label, weight });
  const type = facts["action.type"] as string;

  const sensitive = (facts["resource.classification_rank"] as number) >= 2;
  if (sensitive && facts["destination.external"]) add("sensitive_external", "Sensitive data leaving the trust boundary", 30);
  else if (sensitive) add("sensitive_data", `${String(facts["resource.classification"])} data involved`, 10);
  if (facts["resource.classification"] === "regulated") add("regulated_data", "Regulated (HIPAA) records", 15);
  if (facts["destination.new"] && facts["destination.external"]) add("new_destination", "New or untrusted destination", 15);

  const amount = (facts.amount_usd as number | undefined) ?? 0;
  const records = (facts.record_count as number | undefined) ?? 0;
  if (amount >= 25_000 || records >= 10_000) add("high_impact", amount >= 25_000 ? `High monetary impact ($${amount.toLocaleString("en-US")})` : `Bulk scope (${records.toLocaleString("en-US")} records)`, 20);
  else if (amount >= 5_000 || records >= 1_000) add("elevated_impact", "Elevated monetary/record impact", 10);
  if (amount >= 250_000 || records >= 100_000) add("extreme_impact", "Extreme scope", 10);

  if (["payment", "refund", "data_export", "record_release", "external_send", "email_send", "delete"].includes(type)) add("irreversible", "Hard to reverse once executed", 10);
  if (type === "operational_stop") add("physical_impact", "Stops physical infrastructure", 25);
  if (facts["signals.actor_anomaly"]) add("actor_anomaly", "Actor behaviour outside baseline", 15);
  if (facts["signals.fraud_signal"]) add("fraud_signal", "Customer fraud signal (bank change / first payment)", 15);
  if (!facts["context.justified"]) add("missing_justification", "Missing business justification", 10);
  if (facts["resource.environment"] === "production" || type === "grant_access") add("privileged_env", "Privileged environment or access", 15);
  if (facts["signals.outside_change_window"]) add("outside_window", "Outside approved change window", 10);
  if (facts["context.incident_active"] && type === "deploy") add("incident_change", "Change during an active incident", 5);
  if (facts["context.change_request"]) add("verified_context", "Linked change request", -10);
  if (facts["destination.approved"] === true) add("approved_destination", "Destination on tenant allowlist", -15);

  const base = 10;
  const score = Math.max(0, Math.min(100, base + reasons.reduce((s, r) => s + r.weight, 0)));
  const level: RiskLevel = score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  return { score, level, reasons };
}

export function publishedVersion(policy: Policy): PolicyVersion | undefined {
  return policy.versions.find((v) => v.version === policy.current_version && v.status !== "draft");
}

/**
 * Evaluate an action against the given policy versions. Deterministic; no I/O, no model calls.
 * The most severe matching effect wins. A frozen actor is always denied.
 */
export function evaluate(
  env: ActionEnvelope,
  versions: Array<{ policy: Pick<Policy, "id" | "name">; version: PolicyVersion }>,
  ctx: EvaluationContext,
): Evaluation {
  const facts = deriveFacts(env, ctx);
  const risk = scoreRisk(facts);
  const matched: Array<MatchedRule & { rule: PolicyRule }> = [];

  for (const { policy, version } of versions) {
    for (const rule of version.rules) {
      if (ruleMatches(rule, facts)) {
        matched.push({
          policy_id: policy.id,
          policy_name: policy.name,
          version: version.version,
          rule_id: rule.id,
          rule_name: rule.name,
          effect: rule.effect,
          reason: rule.reason,
          rule,
        });
      }
    }
  }

  if (facts["actor.frozen"]) {
    const frozenRule: MatchedRule = {
      policy_id: "sys_freeze",
      policy_name: "Emergency freeze",
      version: 1,
      rule_id: "frozen_actor",
      rule_name: "Actor is frozen",
      effect: "freeze",
      reason: "This actor is frozen by an authorized operator. All new requests are rejected until restored.",
    };
    return {
      status: "deny",
      effect: "freeze",
      frozen: true,
      risk: { ...risk, level: "critical", score: Math.max(risk.score, 90) },
      matched: [frozenRule, ...matched.map(strip)],
      deciding: frozenRule,
      safe_alternatives: [],
      facts,
    };
  }

  matched.sort((a, b) => EFFECT_SEVERITY[b.effect] - EFFECT_SEVERITY[a.effect]);
  const top = matched[0];
  const effect: Effect = top?.effect ?? "allow";

  const status =
    effect === "deny" || effect === "freeze"
      ? "deny"
      : effect === "require_approval" || effect === "require_quorum" || effect === "require_confirmation"
        ? "approval_required"
        : effect === "warn"
          ? "warn"
          : "allow";

  // Merge safe alternatives and editable fields from every approval-class rule that matched.
  const approvalRules = matched.filter((m) => EFFECT_SEVERITY[m.effect] >= EFFECT_SEVERITY.require_confirmation && m.effect !== "deny");
  const safe = dedupe(approvalRules.flatMap((m) => m.rule.safe_alternatives ?? []), (a) => a.id);
  const editable = dedupe(approvalRules.flatMap((m) => m.rule.editable_fields ?? []), (f) => f.key);

  const evaluation: Evaluation = {
    status,
    effect,
    frozen: false,
    risk,
    matched: matched.map(strip),
    deciding: top ? strip(top) : undefined,
    safe_alternatives: status === "approval_required" ? safe : [],
    facts,
  };

  if (status === "approval_required" && top) {
    const stepUp = approvalRules.some((m) => m.rule.step_up === "biometric") || risk.level === "critical" ? "biometric" : "none";
    evaluation.approval = {
      route: top.rule.route ?? "security",
      step_up: stepUp,
      quorum: top.effect === "require_quorum" ? (top.rule.quorum ?? { required: 2, of: 3 }) : undefined,
      ttl_seconds: env.ttl_seconds ?? top.rule.ttl_seconds ?? 900,
      editable_fields: editable,
    };
  }
  return evaluation;
}

function strip(m: MatchedRule & { rule?: PolicyRule }): MatchedRule {
  const { rule: _rule, ...rest } = m;
  void _rule;
  return rest;
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Run a candidate set of policy versions against historical envelopes and diff against the live set. */
export function simulate(
  envelopes: Array<{ id: string; envelope: ActionEnvelope; at: Date }>,
  live: Parameters<typeof evaluate>[1],
  candidate: Parameters<typeof evaluate>[1],
  ctxFor: (at: Date) => EvaluationContext,
) {
  const rows = envelopes.map(({ id, envelope, at }) => {
    const ctx = ctxFor(at);
    const a = evaluate(envelope, live, ctx);
    const b = evaluate(envelope, candidate, ctx);
    return {
      action_id: id,
      title: envelope.action.title ?? envelope.action.type,
      actor: envelope.actor.id,
      current: { status: a.status, effect: a.effect, rule: a.deciding?.rule_name },
      candidate: { status: b.status, effect: b.effect, rule: b.deciding?.rule_name },
      changed: a.status !== b.status || a.effect !== b.effect,
      risk: a.risk.score,
    };
  });
  const tally = (key: "current" | "candidate") =>
    rows.reduce<Record<string, number>>((acc, r) => {
      acc[r[key].status] = (acc[r[key].status] ?? 0) + 1;
      return acc;
    }, {});
  return {
    total: rows.length,
    changed: rows.filter((r) => r.changed).length,
    status_changed: rows.filter((r) => r.current.status !== r.candidate.status).length,
    current: tally("current"),
    candidate: tally("candidate"),
    rows,
  };
}
