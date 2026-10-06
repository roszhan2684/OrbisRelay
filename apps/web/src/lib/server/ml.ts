import "server-only";
import { createPrivateKey, createHash, sign } from "node:crypto";
import { combineSignals, fuse, type ActionEnvelope, type DecisionStatus, type Effect, type MlSignal } from "@orbis/policy-core";
import type { DB, EndpointRecord, Integration, MlLabel, MlModelRecord, MlPrediction, ModelStatus } from "../domain";
import { envelopeToEvent } from "../ml/edge/adapter";
import { anomaly as anomalyOf, compute, FEATURE_SCHEMA, FeatureState, fi, update, validate } from "../ml/edge/features";
import { decide, explain, LABELS, logits, reasons, type DecisionPolicy, type PortableModel } from "../ml/edge/model";
import registry from "../ml/edge/registry.json";
import m090 from "../ml/edge/models/0.9.0.json";
import m100 from "../ml/edge/models/1.0.0.json";
import m110 from "../ml/edge/models/1.1.0.json";
import { id, newSigningKey } from "./crypto";

// ---------------------------------------------------------------- registry + artifacts

type Artifact = { model: PortableModel; policy: DecisionPolicy };
const ARTIFACTS: Record<string, Artifact> = {
  "0.9.0": m090 as unknown as Artifact,
  "1.0.0": m100 as unknown as Artifact,
  "1.1.0": m110 as unknown as Artifact,
};
export type RegistryEntry = (typeof registry.versions)[number];
export const REGISTRY = registry;
export const registryEntry = (v: string) => registry.versions.find((x) => x.version === v) as RegistryEntry | undefined;
export const MODEL_NAME = "orbis-edge-risk";
export const ENDPOINT_APP_VERSION = "2.0.0";

/** Features monitored for drift (subset of edge-features/1). */
export const DRIFT_FEATURES = ["resource_log", "amount_log", "rate_1h", "rate_ratio", "first_destination", "x_sensitive_external", "x_sensitive_untrusted", "class_rank", "off_hours", "unique_dest_1h"];

/** Lifecycle at time `t`, replayed from the recorded history (so historical seed traffic uses the model that was live then). */
export function lifecycleAt(db: DB, t: number): Record<string, { status: ModelStatus; percent: number }> {
  const out: Record<string, { status: ModelStatus; percent: number }> = {};
  for (const m of db.ml.models) {
    let cur: { status: ModelStatus; percent: number } | null = null;
    for (const h of m.history) if (new Date(h.at).getTime() <= t) cur = { status: h.to, percent: h.percent ?? (h.to === "production" ? 100 : 0) };
    if (cur) out[m.version] = cur;
  }
  return out;
}

export function roleVersions(db: DB, t = Date.now()) {
  const lc = lifecycleAt(db, t);
  const find = (s: ModelStatus) => Object.entries(lc).filter(([, v]) => v.status === s).map(([k, v]) => ({ version: k, percent: v.percent }));
  return { production: find("production")[0]?.version ?? null, canary: find("canary")[0] ?? null, shadow: find("shadow")[0]?.version ?? null };
}

/** Deterministic 0-99 bucket for canary assignment (by actor for cloud scoring, by endpoint for distribution). */
export const bucketOf = (key: string) => parseInt(createHash("sha256").update(`canary:${key}`).digest("hex").slice(0, 8), 16) % 100;

// ---------------------------------------------------------------- scoring

export interface Scored {
  prediction: MlPrediction;
  signal: MlSignal | null;
  availability: { available: boolean; reason?: "kill_switch" | "model_unavailable" | "stale_model" | "incompatible_schema" | "disabled" | "inference_error" };
}

function adapterCtx(db: DB, integration: Integration) {
  return {
    tenant_id: db.tenant.id,
    approved: new Set(db.approved_destinations.map((d) => d.toLowerCase())),
    tools: Object.fromEntries(db.actors.map((a) => [a.id, Object.fromEntries(a.tools.map((t) => [t.tool, t.risk_class]))])),
    managed: integration.kind !== "sandbox",
  };
}

const runtime = (v: string, x: number[]) => {
  const a = ARTIFACTS[v];
  return decide(logits(a.model, x), x, a.policy);
};

/** Endpoint-supplied signal (from the Swift/Core ML runtime). Validated; never trusted to lower risk. */
export interface EndpointSignalInput {
  endpoint_id: string;
  event_id?: string;
  signal: { source?: string; model_version?: string; feature_schema?: string; class?: string; risk?: number; abstain?: boolean; ood?: boolean; runtime?: string; inference_us?: number; reasons?: Array<{ code: string; label: string }> };
}

export function parseEndpointSignal(raw: unknown): EndpointSignalInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const s = r.signal as Record<string, unknown> | undefined;
  if (typeof r.endpoint_id !== "string" || !s || typeof s !== "object") return undefined;
  return {
    endpoint_id: r.endpoint_id.slice(0, 80),
    event_id: typeof r.event_id === "string" ? r.event_id.slice(0, 128) : undefined,
    signal: {
      source: typeof s.source === "string" ? s.source : undefined,
      model_version: typeof s.model_version === "string" ? s.model_version.slice(0, 20) : undefined,
      feature_schema: typeof s.feature_schema === "string" ? s.feature_schema : undefined,
      class: typeof s.class === "string" ? s.class : undefined,
      risk: typeof s.risk === "number" && Number.isFinite(s.risk) ? s.risk : undefined,
      abstain: s.abstain === true,
      ood: s.ood === true,
      runtime: typeof s.runtime === "string" ? s.runtime.slice(0, 40) : undefined,
      inference_us: typeof s.inference_us === "number" ? s.inference_us : undefined,
      reasons: Array.isArray(s.reasons) ? (s.reasons as Array<{ code: string; label: string }>).slice(0, 6).map((x) => ({ code: String(x.code).slice(0, 40), label: String(x.label).slice(0, 120) })) : undefined,
    },
  };
}

/**
 * Score an action (cloud-side, deterministic) and fold in a validated endpoint signal. Mutates the
 * per-actor baseline state in the DB — called only from inside an op, so every replica agrees.
 */
export function score(db: DB, envelope: ActionEnvelope, integration: Integration, at: Date, endpoint?: EndpointSignalInput): Scored {
  const t = at.getTime();
  const roles = roleVersions(db, t);
  const state = new FeatureState(db.ml.baselines);
  const ev = validate(envelopeToEvent(envelope, at, adapterCtx(db, integration)));
  const x = compute(ev, state);
  const an = anomalyOf(ev, state);
  update(ev, state);
  const base = {
    id: id("pred"),
    action_id: "",
    actor_id: envelope.actor.id,
    at: at.toISOString(),
    feature_schema: FEATURE_SCHEMA,
    canonical_action: ev.action_type,
    anomaly: { score: an.score, sufficient: an.sufficient, top: an.contributions.slice(0, 3).map((c) => c.feature) },
    drift: DRIFT_FEATURES.map((n) => x[fi(n)]),
    deterministic_status: "allow" as DecisionStatus,
    fusion: { rule: "", changed: false, reason: "" },
  };
  const actorKind = envelope.actor.type === "human" ? "person" : envelope.actor.type === "agent" ? "agent" : "automation";
  const fallback = (reason: Scored["availability"]["reason"]): Scored => ({
    prediction: { ...base, source: "fallback", model_version: null, policy_version: null, class: null, risk: null, probs: null, abstain: true, ood: x[fi("unknown_fields")] > 0, guarded: false, high_impact: false, reasons: reasons(x), explanation: "Model not consulted — deterministic policy decided.", fallback: reason },
    signal: null,
    availability: { available: false, reason },
  });
  if (db.ml.kill_switch) return fallback("kill_switch");
  if (db.ml.fusion.mode === "off") return fallback("disabled");
  let version = roles.production;
  if (roles.canary && bucketOf(envelope.actor.id) < roles.canary.percent) version = roles.canary.version;
  if (!version || !ARTIFACTS[version]) return fallback("model_unavailable");
  if (ARTIFACTS[version].model.feature_schema !== FEATURE_SCHEMA) return fallback("incompatible_schema");
  const d = runtime(version, x);
  const rs = reasons(x);
  const prediction: MlPrediction = {
    ...base,
    source: "cloud",
    model_version: version,
    policy_version: ARTIFACTS[version].policy.version,
    class: d.label,
    risk: d.risk,
    probs: d.probs,
    abstain: d.abstain,
    ood: d.ood,
    guarded: d.guarded,
    high_impact: d.high_impact,
    reasons: rs,
    explanation: explain(d.label, rs, actorKind, d.abstain),
  };
  if (roles.shadow && roles.shadow !== version && ARTIFACTS[roles.shadow]) {
    const s = runtime(roles.shadow, x);
    prediction.shadow = { model_version: roles.shadow, class: s.label, risk: s.risk };
  }
  let cloud: MlSignal = { source: "cloud", model_version: version, feature_schema: FEATURE_SCHEMA, class: d.label, risk: d.risk, abstain: d.abstain, ood: d.ood, high_impact: d.high_impact, reasons: rs, anomaly: an.sufficient ? an.score : null };
  let local: MlSignal | null = null;
  if (endpoint) {
    const ep = db.ml.endpoints.find((e) => e.id === endpoint.endpoint_id);
    const s = endpoint.signal;
    const ok = ep && ep.state !== "revoked" && s.feature_schema === FEATURE_SCHEMA && s.model_version && registryEntry(s.model_version) && LABELS.includes(s.class as MlLabel) && typeof s.risk === "number" && s.risk >= 0 && s.risk <= 1;
    if (ok) {
      local = { source: "local", model_version: s.model_version!, feature_schema: FEATURE_SCHEMA, class: s.class as MlLabel, risk: s.risk!, abstain: !!s.abstain, ood: !!s.ood, high_impact: d.high_impact, reasons: s.reasons?.length ? s.reasons : rs, anomaly: cloud.anomaly };
      prediction.local = { endpoint_id: ep!.id, model_version: s.model_version!, runtime: s.runtime ?? "coreml", class: s.class as MlLabel, risk: s.risk!, inference_us: s.inference_us, agreed: LABELS.indexOf(s.class as MlLabel) >= 2 === d.cls >= 2 };
    }
  }
  const combined = combineSignals(local, cloud);
  if (combined && local) {
    prediction.source = combined.source;
    cloud = combined;
  }
  return { prediction, signal: local ? cloud : cloud, availability: { available: true } };
}

export function fuseDecision(db: DB, det: { status: DecisionStatus; effect: Effect; frozen: boolean }, scored: Scored) {
  const r = fuse(det, scored.signal, scored.availability, db.ml.fusion);
  scored.prediction.deterministic_status = det.status;
  scored.prediction.fusion = { rule: r.rule, changed: r.changed, reason: r.reason };
  return r;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function approvalMl(db: DB, p: MlPrediction): import("../domain").ApprovalMl | undefined {
  if (!p.class || p.risk === null || !p.model_version) return undefined;
  const ep = p.local ? db.ml.endpoints.find((e) => e.id === p.local!.endpoint_id) : undefined;
  const a = db.actors.find((x) => x.id === p.actor_id);
  const anomalyLine = p.anomaly.sufficient ? `Behaviour score ${pct(p.anomaly.score)} vs this ${a?.type === "human" ? "person" : "actor"}'s own history${p.anomaly.top.length ? ` (${p.anomaly.top.join(", ").replace(/_/g, " ")})` : ""}` : "Not enough history for a behavioural baseline yet";
  return {
    source: p.source === "fallback" ? "cloud" : p.source,
    model_version: p.model_version,
    runtime: p.local ? p.local.runtime : "gateway (TypeScript port)",
    class: p.class,
    risk: p.risk,
    abstain: p.abstain,
    reasons: p.reasons,
    explanation: p.explanation,
    anomaly: p.anomaly.sufficient ? p.anomaly.score : null,
    anomaly_top: p.anomaly.top,
    baseline: anomalyLine,
    fusion_rule: p.fusion.rule,
    model_health: ep ? `${ep.name} · ${ep.state} · p95 ${ep.health.inference_p95_ms.toFixed(2)} ms` : `Gateway scorer healthy · ${registryEntry(p.model_version)?.gates?.status === "pass" ? "release gates passed" : "gates pending"}`,
  };
}

// ---------------------------------------------------------------- manifests (cloud → endpoint distribution)

export function modelSigningKey() {
  return newSigningKey("orbis-model-signing-2026", `${process.env.ORBIS_SIGNING_SEED ?? "orbis-relay-demo-signing-key"}:models`);
}

/** Version an endpoint should run: production, or the canary if its bucket is inside the rollout. */
export function assignedVersion(db: DB, ep: EndpointRecord, t = Date.now()) {
  const roles = roleVersions(db, t);
  if (roles.canary && ep.bucket < roles.canary.percent) return roles.canary.version;
  return roles.production;
}

export function signedManifest(db: DB, ep: EndpointRecord, origin = "") {
  const version = assignedVersion(db, ep);
  if (!version) return null;
  const entry = registryEntry(version);
  const dist = (entry?.artifacts as Record<string, unknown> | undefined)?.coreml_fp32_zip as { url: string; sha256: string; bytes: number } | undefined;
  if (!entry || !dist) return null;
  const policyJson = JSON.stringify(ARTIFACTS[version].policy);
  const now = Date.now();
  const lc = lifecycleAt(db, now)[version];
  const payload = JSON.stringify({
    manifest_seq: db.ml.manifest_seq,
    tenant_id: db.tenant.id,
    model_name: MODEL_NAME,
    version,
    feature_schema: entry.feature_schema,
    runtime: "coreml",
    precision: "fp32",
    minimum_app_version: ENDPOINT_APP_VERSION,
    artifact_url: `${origin}/api/v1/endpoint/models/${MODEL_NAME}/${version}/artifact`,
    artifact_sha256: dist.sha256,
    policy_sha256: createHash("sha256").update(policyJson).digest("hex"),
    policy_json: policyJson,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 7 * 86_400_000).toISOString(),
    rollback_to: previousProduction(db, version),
    stage: lc?.status ?? "production",
    kill_switch: db.ml.kill_switch,
  });
  const key = db.ml.signing_key;
  const signature = sign(null, Buffer.from(payload), createPrivateKey(key.private_pem)).toString("base64");
  return { payload, signature, key_id: key.id };
}

function previousProduction(db: DB, current: string) {
  const prods = db.ml.models.flatMap((m) => m.history.filter((h) => h.to === "production").map((h) => ({ v: m.version, at: h.at }))).sort((a, b) => a.at.localeCompare(b.at));
  const older = prods.filter((p) => p.v !== current);
  return older.length ? older[older.length - 1].v : null;
}

// ---------------------------------------------------------------- lifecycle ops

const ORDER: ModelStatus[] = ["trained", "evaluated", "candidate", "shadow", "canary", "production"];

export function promote(db: DB, version: string, to: ModelStatus, percent: number | undefined, by: { id: string; name: string }, reason: string, at: Date, automatic = false) {
  const m = db.ml.models.find((x) => x.version === version);
  if (!m) throw new Error("unknown_model");
  const entry = registryEntry(version);
  if (["shadow", "canary", "production"].includes(to) && entry?.gates?.status !== "pass") throw new Error("gates_not_passed");
  if (ORDER.indexOf(to) >= 0 && ORDER.indexOf(m.status) >= 0 && ORDER.indexOf(to) < ORDER.indexOf(m.status) && to !== "candidate") throw new Error("not_forward");
  const iso = at.toISOString();
  if (to === "production") {
    for (const other of db.ml.models) {
      if (other.version !== version && (other.status === "production" || other.status === "canary")) {
        other.status = "deprecated";
        other.rollout_percent = 0;
        other.history.push({ at: iso, version: other.version, to: "deprecated", by: by.name, reason: `superseded by ${version}`, automatic });
      }
    }
  }
  if (to === "canary" || to === "shadow") {
    for (const other of db.ml.models) if (other.version !== version && other.status === to) {
      other.status = "candidate";
      other.history.push({ at: iso, version: other.version, to: "candidate", by: by.name, reason: `replaced in ${to} by ${version}`, automatic });
    }
  }
  m.status = to;
  m.rollout_percent = to === "production" ? 100 : to === "canary" ? Math.max(1, Math.min(99, percent ?? 5)) : 0;
  m.history.push({ at: iso, version, to, percent: m.rollout_percent, by: by.name, reason, automatic });
  db.ml.manifest_seq += 1;
  return m;
}

export function rollback(db: DB, version: string, by: { id: string; name: string }, reason: string, at: Date, automatic = false) {
  const m = db.ml.models.find((x) => x.version === version);
  if (!m || !["canary", "production", "shadow"].includes(m.status)) throw new Error("not_deployed");
  const iso = at.toISOString();
  const target = previousProduction(db, version);
  // A rolled-back model returns to candidate: it keeps its passing gates, but needs a fresh rollout.
  m.history.push({ at: iso, version, to: "candidate", by: by.name, reason: `rolled back: ${reason}`, automatic });
  m.status = "candidate";
  m.rollout_percent = 0;
  if (target && m.history.some((h) => h.to === "production")) {
    const t = db.ml.models.find((x) => x.version === target)!;
    t.status = "production";
    t.rollout_percent = 100;
    t.history.push({ at: iso, version: target, to: "production", percent: 100, by: by.name, reason: `rollback target for ${version}`, automatic });
  }
  db.ml.manifest_seq += 1;
  return { rolled_back: version, active: roleVersions(db, at.getTime() + 1).production };
}

// ---------------------------------------------------------------- monitoring

function psi(ref: number[], cur: number[], bins = 10) {
  const EPS = 1e-4;
  if (!ref.length || !cur.length) return 0;
  const s = [...ref].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const edges = [...new Set(Array.from({ length: bins - 1 }, (_, i) => q((i + 1) / bins)))];
  let P: number[], Q: number[];
  if (edges.length < 2) {
    const vals = [...new Set([...ref, ...cur])];
    P = vals.map((v) => ref.filter((x) => x === v).length / ref.length);
    Q = vals.map((v) => cur.filter((x) => x === v).length / cur.length);
  } else {
    const hist = (xs: number[]) => {
      const h = new Array(edges.length + 1).fill(0);
      for (const x of xs) {
        let k = 0;
        while (k < edges.length && x > edges[k]) k++;
        h[k]++;
      }
      return h.map((c) => c / xs.length);
    };
    P = hist(ref);
    Q = hist(cur);
  }
  return P.reduce((acc, p, i) => {
    const pp = Math.max(p, EPS), qq = Math.max(Q[i], EPS);
    return acc + (qq - pp) * Math.log(qq / pp);
  }, 0);
}

export function computeDrift(db: DB, now = Date.now()) {
  const preds = db.ml.predictions.filter((p) => p.class !== null);
  const day = 86_400_000;
  const refEnd = now - 14 * day;
  const ref = preds.filter((p) => new Date(p.at).getTime() < refEnd);
  // Prediction drift is only meaningful within one model: its reference is the first 4 days of the
  // current production model (feature drift keeps the longer, model-independent reference).
  const prod = roleVersions(db, now).production;
  const prodSince = db.ml.models.find((m) => m.version === prod)?.history.filter((h) => h.to === "production").map((h) => new Date(h.at).getTime()).pop() ?? refEnd;
  const predRef = preds.filter((p) => p.model_version === prod && new Date(p.at).getTime() >= prodSince && new Date(p.at).getTime() < prodSince + 4 * day);
  const windows = [];
  for (let k = 5; k >= 0; k--) {
    const end = now - k * day, start = end - 7 * day;
    const cur = preds.filter((p) => { const t = new Date(p.at).getTime(); return t >= start && t < end; });
    if (!cur.length || !ref.length) continue;
    const feats = DRIFT_FEATURES.map((n, i) => ({ feature: n, psi: psi(ref.map((p) => p.drift[i]), cur.map((p) => p.drift[i])), ref_mean: ref.reduce((s, p) => s + p.drift[i], 0) / ref.length, cur_mean: cur.reduce((s, p) => s + p.drift[i], 0) / cur.length }));
    const curProd = cur.filter((p) => p.model_version === prod);
    const predPsi = predRef.length && curProd.length ? psi(predRef.map((p) => p.risk ?? 0), curProd.map((p) => p.risk ?? 0)) : 0;
    const ood = cur.filter((p) => p.ood).length / cur.length;
    const max = Math.max(...feats.map((f) => f.psi));
    windows.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), n: cur.length, max_feature_psi: max, prediction_psi: predPsi, ood_rate: ood, level: ood >= 0.05 ? "critical" : max >= 0.25 || predPsi >= 0.25 ? "warn" : max >= 0.1 ? "info" : "ok", features: feats.sort((a, b) => b.psi - a.psi) });
  }
  // Behavioural drift: per-actor daily mean anomaly score over the last 10 days (Demo B).
  const actors = [...new Set(preds.map((p) => p.actor_id))];
  const behaviour = actors.map((a) => {
    const days = Array.from({ length: 10 }, (_, k) => {
      const end = now - (9 - k) * day, start = end - day;
      const xs = preds.filter((p) => p.actor_id === a && p.anomaly.sufficient && new Date(p.at).getTime() >= start && new Date(p.at).getTime() < end).map((p) => p.anomaly.score);
      return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
    });
    const vals = days.filter((v): v is number => v !== null);
    return { actor_id: a, daily: days, latest: vals[vals.length - 1] ?? null, rise: vals.length >= 2 ? vals[vals.length - 1] - vals[0] : 0 };
  }).filter((b) => b.latest !== null).sort((x, y) => (y.latest ?? 0) - (x.latest ?? 0));
  let streak = 0;
  for (const w of windows) streak = w.level === "warn" || w.level === "critical" ? streak + 1 : 0;
  const labelled = db.ml.feedback.length;
  return {
    reference: { start: ref[0]?.at ?? null, end: new Date(refEnd).toISOString(), n: ref.length, prediction_reference: { model_version: prod, start: new Date(prodSince).toISOString(), n: predRef.length } },
    window_days: 7,
    windows,
    behaviour: behaviour.slice(0, 8),
    trigger: { sustained_windows: streak, sustained_required: 2, labelled_outcomes: labelled, labels_required: 200, propose_candidate_retraining: streak >= 2 && labelled >= 200, auto_promote: false },
  };
}

export function computeQuality(db: DB, now = Date.now()) {
  const day = 86_400_000;
  const preds = db.ml.predictions;
  const days = Array.from({ length: 14 }, (_, k) => {
    const end = now - (13 - k) * day, start = end - day;
    const xs = preds.filter((p) => { const t = new Date(p.at).getTime(); return t >= start && t < end; });
    const by = (c: MlLabel) => xs.filter((p) => p.class === c).length;
    return {
      date: new Date(start).toISOString().slice(0, 10),
      n: xs.length,
      safe_normal: by("safe_normal"), safe_unusual: by("safe_unusual"), suspicious_review: by("suspicious_review"), high_risk: by("high_risk"),
      fallback: xs.filter((p) => p.class === null).length,
      abstain: xs.filter((p) => p.abstain && p.class !== null).length,
      escalated_by_model: xs.filter((p) => p.fusion.changed).length,
    };
  });
  const scored = preds.filter((p) => p.class !== null);
  const policyEsc = (p: MlPrediction) => p.deterministic_status === "approval_required" || p.deterministic_status === "deny";
  const modelEsc = (p: MlPrediction) => p.class === "suspicious_review" || p.class === "high_risk";
  const disagree = scored.filter((p) => policyEsc(p) !== modelEsc(p));
  // Human disagreement: approvals the human approved although the model said high risk, and the reverse.
  const humanRows = scored.flatMap((p) => {
    const a = db.actions.find((x) => x.id === p.action_id);
    const ap = a?.approval_id ? db.approvals.find((x) => x.id === a.approval_id) : undefined;
    if (!ap || ap.status === "pending" || ap.status === "expired" || ap.status === "cancelled") return [];
    const human = ap.status === "rejected" ? "block" : ap.status === "approved_modified" ? "modify" : "approve";
    return [{ p, human }];
  });
  const fb = db.ml.feedback;
  const confirmedFP = fb.filter((f) => { const p = preds.find((x) => x.id === f.prediction_id); return p && modelEsc(p) && (f.label === "safe_normal" || f.label === "safe_unusual"); }).length;
  const confirmedFN = fb.filter((f) => { const p = preds.find((x) => x.id === f.prediction_id); return p && !modelEsc(p) && (f.label === "suspicious_review" || f.label === "high_risk"); }).length;
  const localRows = preds.filter((p) => p.local);
  return {
    days,
    totals: {
      predictions: preds.length,
      scored: scored.length,
      fallback_rate: preds.length ? (preds.length - scored.length) / preds.length : 0,
      abstention_rate: scored.length ? scored.filter((p) => p.abstain).length / scored.length : 0,
      policy_model_disagreement_rate: scored.length ? disagree.length / scored.length : 0,
      model_escalations: preds.filter((p) => p.fusion.changed).length,
      human_disagreement_rate: humanRows.length ? humanRows.filter((r) => (r.p.class === "high_risk") !== (r.human === "block")).length / humanRows.length : 0,
      human_decisions: humanRows.length,
      confirmed_false_positives: confirmedFP,
      confirmed_false_negatives: confirmedFN,
      reviewed: fb.length,
      local_signals: localRows.length,
      local_cloud_disagreements: localRows.filter((p) => !p.local!.agreed).length,
      shadow_agreement: (() => {
        const s = preds.filter((p) => p.shadow && p.class);
        return s.length ? { n: s.length, versions: [...new Set(s.map((p) => `${p.model_version}→${p.shadow!.model_version}`))], agreement: s.filter((p) => (LABELS.indexOf(p.shadow!.class) >= 2) === (LABELS.indexOf(p.class!) >= 2)).length / s.length } : null;
      })(),
    },
  };
}

/** Active-review queue (blueprint §19): uncertainty, policy/model disagreement, novelty, high impact. */
export function reviewQueue(db: DB, limit = 60) {
  const reviewed = new Set(db.ml.feedback.map((f) => f.prediction_id));
  const rows = db.ml.predictions
    .filter((p) => p.class && !reviewed.has(p.id))
    .map((p) => {
      const why: string[] = [];
      const policyEsc = p.deterministic_status === "approval_required" || p.deterministic_status === "deny";
      const modelEsc = p.class === "suspicious_review" || p.class === "high_risk";
      if (p.abstain) why.push(p.ood ? "out_of_distribution" : "uncertain");
      if (policyEsc !== modelEsc) why.push(modelEsc ? "model_escalated_policy_allowed" : "policy_escalated_model_allowed");
      if (p.local && !p.local.agreed) why.push("endpoint_cloud_disagreement");
      if (p.fusion.changed) why.push("model_changed_outcome");
      if (p.reasons.some((r) => r.code === "first_destination") && p.reasons.some((r) => r.code === "new_tool")) why.push("novel_combination");
      if (p.high_impact && modelEsc) why.push("high_impact");
      const priority = (p.abstain ? 3 : 0) + (policyEsc !== modelEsc ? 2 : 0) + (p.local && !p.local.agreed ? 3 : 0) + (p.fusion.changed ? 1 : 0) + (p.high_impact && modelEsc ? 0.5 : 0) + (p.risk ?? 0) * 0.1;
      return { p, why, priority };
    })
    .filter((r) => r.why.length)
    .sort((a, b) => b.priority - a.priority || b.p.at.localeCompare(a.p.at));
  return { total: rows.length, items: rows.slice(0, limit) };
}

export function newModelRecords(now: Date): MlModelRecord[] {
  const d = (days: number, hours = 0) => new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
  const by = "Avery Kim";
  return [
    {
      version: "0.9.0", status: "deprecated", rollout_percent: 0, created_at: d(46),
      history: [
        { at: d(46), version: "0.9.0", to: "candidate", by: "training pipeline", reason: "logistic-regression baseline passed offline gates" },
        { at: d(44), version: "0.9.0", to: "shadow", by, reason: "shadow on demo endpoints" },
        { at: d(40), version: "0.9.0", to: "production", percent: 100, by, reason: "first edge model in production" },
        { at: d(15), version: "0.9.0", to: "deprecated", by, reason: "superseded by 1.0.0" },
      ],
    },
    {
      version: "1.0.0", status: "production", rollout_percent: 100, created_at: d(21),
      history: [
        { at: d(21), version: "1.0.0", to: "candidate", by: "training pipeline", reason: "mlp-32x16 selected on validation cost; all release gates passed" },
        { at: d(20), version: "1.0.0", to: "shadow", by, reason: "shadow-score live traffic against 0.9.0" },
        { at: d(17), version: "1.0.0", to: "canary", percent: 5, by, reason: "shadow agreement acceptable; 5% canary" },
        { at: d(16), version: "1.0.0", to: "canary", percent: 25, by, reason: "no health or quality regressions at 5%" },
        { at: d(15), version: "1.0.0", to: "production", percent: 100, by, reason: "25% canary clean for 24h" },
      ],
    },
    {
      version: "1.1.0", status: "candidate", rollout_percent: 0, created_at: d(1, 3),
      history: [{ at: d(1, 3), version: "1.1.0", to: "candidate", by: "retraining pipeline", reason: "red-team finding (asserted-ticket refunds) + reviewed Q4 window labels; awaiting release gates" }],
    },
  ];
}

export { id as mlId };
