import "server-only";
import type { PolicyRule } from "@orbis/policy-core";
import type { ActionEnvelope } from "@orbis/policy-core";
import type { ApiKey, DB, Device, EndpointRecord, MlLabel, ModelStatus, OutcomeStatus, ProtectAnalysis } from "../domain";
import { bucketOf, ENDPOINT_APP_VERSION, promote, rollback, roleVersions, type EndpointSignalInput } from "./ml";
import { hashJson, id, withSeededIds } from "./crypto";
import { ApiError, cancelApproval, freezeActor, preflight, reportOutcome, respond, unfreezeActor, type RespondInput } from "./gateway";
import { audit, emit, persist } from "./store";

/**
 * Every state change is an Op. Ops are applied deterministically — ids are derived from the op id and
 * timestamps come from the op — so any instance replaying the shared op log reaches the same state.
 */
export type Op =
  | { kind: "preflight"; integration_id: string; envelope: ActionEnvelope; force?: { route: string; reason: string }; endpoint?: EndpointSignalInput }
  | { kind: "respond"; approval_id: string; user_id: string; input: RespondInput }
  | { kind: "cancel"; approval_id: string; integration_id: string }
  | { kind: "outcome"; action_id: string; integration_id: string; status: OutcomeStatus; detail?: string }
  | { kind: "freeze"; actor_id: string; user_id: string; reason: string; channel: "ios" | "web" | "api" }
  | { kind: "unfreeze"; actor_id: string; user_id: string; reason: string }
  | { kind: "policy_draft"; policy_id: string; user_id: string; rules: PolicyRule[]; note?: string }
  | { kind: "policy_publish"; policy_id: string; user_id: string; second_approver_id?: string; version?: number }
  | { kind: "settings"; user_id: string; patch: Record<string, unknown> }
  | { kind: "protect"; analysis: ProtectAnalysis }
  | { kind: "key_create"; integration_id: string; user_id: string; key: ApiKey }
  | { kind: "key_revoke"; key_id: string; user_id: string }
  | { kind: "device_register"; user_id: string; device: Device }
  | { kind: "device_revoke"; device_id: string; user_id: string }
  | { kind: "signin"; user_id: string }
  | { kind: "ml_promote"; version: string; to: ModelStatus; percent?: number; user_id: string; reason: string }
  | { kind: "ml_rollback"; version: string; user_id: string; reason: string }
  | { kind: "ml_review"; prediction_id: string; label: MlLabel; user_id: string; note?: string }
  | { kind: "ml_settings"; user_id: string; mode?: "off" | "advisory" | "escalate"; kill_switch?: boolean }
  | { kind: "endpoint_checkin"; integration_id: string; endpoint_id: string; meta?: { name?: string; os?: string; app_version?: string }; health?: Partial<EndpointRecord["health"]> & { active_model?: string | null; kill_switch?: boolean; stale_model?: boolean }; events?: { count: number; high_priority: number; dropped?: number }; drill?: boolean }
  | { kind: "endpoint_activation"; integration_id: string; endpoint_id: string; version: string; activated: boolean; error?: string; compile_ms?: number };

export interface OpEnvelope {
  id: string;
  at: string;
  op: Op;
}

const userOf = (db: DB, uid: string) => {
  const u = db.users.find((x) => x.id === uid);
  if (!u) throw new ApiError(404, "unknown_user", "User not found.");
  return u;
};
const integrationOf = (db: DB, iid: string) => {
  const i = db.integrations.find((x) => x.id === iid);
  if (!i) throw new ApiError(404, "not_found", "Integration not found.");
  return i;
};

export function applyOp(db: DB, env: OpEnvelope): unknown {
  const at = new Date(env.at);
  const o = { at };
  return withSeededIds(`op:${env.id}`, () => {
    const op = env.op;
    switch (op.kind) {
      case "preflight":
        return preflight(db, integrationOf(db, op.integration_id), op.envelope, { ...o, forceApproval: op.force, endpointSignal: op.endpoint });
      case "ml_promote":
      case "ml_rollback":
      case "ml_review":
      case "ml_settings":
      case "endpoint_checkin":
      case "endpoint_activation":
        return applyMlOp(db, op, at);
      case "respond":
        return respond(db, op.approval_id, userOf(db, op.user_id), op.input, o);
      case "cancel":
        return cancelApproval(db, op.approval_id, integrationOf(db, op.integration_id), o);
      case "outcome":
        return reportOutcome(db, op.action_id, integrationOf(db, op.integration_id), op.status, op.detail, o);
      case "freeze":
        return freezeActor(db, op.actor_id, userOf(db, op.user_id), op.reason, op.channel, o);
      case "unfreeze":
        return unfreezeActor(db, op.actor_id, userOf(db, op.user_id), op.reason, o);
      case "policy_draft":
        return saveDraft(db, op, at);
      case "policy_publish":
        return publishPolicy(db, op, at);
      case "settings":
        return patchSettings(db, op, at);
      case "protect":
        db.protect.push(op.analysis);
        emit({ type: "protect.analyzed", analysis_id: op.analysis.id, verdict: op.analysis.verdict });
        return op.analysis;
      case "key_create": {
        const integration = integrationOf(db, op.integration_id);
        if (!integration.api_keys.some((k) => k.id === op.key.id)) integration.api_keys.push(op.key);
        const user = userOf(db, op.user_id);
        audit(db, { at: env.at, type: "api_key.created", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "integration", id: integration.id }, summary: `API key ${op.key.prefix}… created for ${integration.name}` });
        return op.key;
      }
      case "key_revoke": {
        const user = userOf(db, op.user_id);
        for (const i of db.integrations) {
          const k = i.api_keys.find((x) => x.id === op.key_id);
          if (k) {
            k.revoked_at ??= env.at;
            audit(db, { at: env.at, type: "api_key.revoked", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "integration", id: i.id }, summary: `API key ${k.prefix}… revoked` });
            return k;
          }
        }
        throw new ApiError(404, "not_found", "Key not found.");
      }
      case "device_register": {
        if (!db.devices.some((d) => d.id === op.device.id)) db.devices.push(op.device);
        const user = userOf(db, op.user_id);
        audit(db, { at: env.at, type: "device.registered", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "device", id: op.device.id }, summary: `${op.device.name} (${op.device.model}) registered via Orbis iOS` });
        return op.device;
      }
      case "device_revoke": {
        const d = db.devices.find((x) => x.id === op.device_id);
        if (!d) throw new ApiError(404, "not_found", "Device not found.");
        d.trust = "revoked";
        d.push = false;
        const user = userOf(db, op.user_id);
        audit(db, { at: env.at, type: "device.revoked", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "device", id: d.id }, summary: `${d.name} revoked — step-up from this device rejected` });
        return d;
      }
      case "signin": {
        const user = userOf(db, op.user_id);
        audit(db, { at: env.at, type: "auth.signin", actor: { kind: "user", id: user.id, name: user.name }, summary: `${user.name} signed in to the console via ${db.tenant.settings.sso.provider}` });
        return user;
      }
    }
  });
}

function saveDraft(db: DB, op: Extract<Op, { kind: "policy_draft" }>, at: Date) {
  const policy = db.policies.find((p) => p.id === op.policy_id);
  if (!policy) throw new ApiError(404, "not_found", "Policy not found.");
  const user = userOf(db, op.user_id);
  let draft = policy.versions.find((v) => v.status === "draft");
  const now = at.toISOString();
  if (!draft) {
    draft = { policy_id: policy.id, version: Math.max(...policy.versions.map((v) => v.version)) + 1, status: "draft", rules: op.rules, change_note: op.note ?? "Draft", created_at: now, created_by: user.email.split("@")[0] };
    policy.versions.push(draft);
  } else {
    draft.rules = op.rules;
    draft.change_note = op.note ?? draft.change_note;
    draft.created_at = now;
  }
  audit(db, { at: now, type: "policy.draft_saved", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "policy", id: policy.id }, summary: `${policy.name} v${draft.version} draft saved — ${draft.change_note}` });
  return draft;
}

function publishPolicy(db: DB, op: Extract<Op, { kind: "policy_publish" }>, at: Date) {
  const policy = db.policies.find((p) => p.id === op.policy_id);
  if (!policy) throw new ApiError(404, "not_found", "Policy not found.");
  const user = userOf(db, op.user_id);
  const draft = policy.versions.find((v) => v.status === "draft" && (op.version === undefined || v.version === op.version));
  if (!draft) throw new ApiError(409, "no_draft", "There is no draft to publish.");
  let second;
  if (db.tenant.settings.policy_publish_requires_second_approver) {
    second = db.users.find((u) => u.id === op.second_approver_id);
    if (!second || second.id === user.id || !second.roles.includes("policy_admin")) throw new ApiError(422, "second_approver_required", "Select a different policy admin as second approver.");
  }
  const now = at.toISOString();
  for (const v of policy.versions) if (v.status === "published") v.status = "superseded";
  draft.status = "published";
  draft.published_at = now;
  draft.checksum = hashJson(draft.rules);
  policy.current_version = draft.version;
  audit(db, { at: now, type: "policy.published", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "policy", id: policy.id }, summary: `${policy.name} v${draft.version} published — ${draft.change_note}`, data: { second_approver: second?.name, checksum: draft.checksum } });
  emit({ type: "policy.published", policy_id: policy.id, version: draft.version });
  return { policy_id: policy.id, version: draft.version, checksum: draft.checksum };
}

// ---------------------------------------------------------------- ML control plane + endpoints

const ML_ADMIN = ["owner", "admin", "policy_admin"];
const LATENCY_BUDGET_MS = 20;

type MlOp = Extract<Op, { kind: "ml_promote" | "ml_rollback" | "ml_review" | "ml_settings" | "endpoint_checkin" | "endpoint_activation" }>;

function applyMlOp(db: DB, op: MlOp, at: Date): unknown {
  const iso = at.toISOString();
  switch (op.kind) {
    case "ml_promote": {
      const user = userOf(db, op.user_id);
      if (!user.roles.some((r) => ML_ADMIN.includes(r))) throw new ApiError(403, "forbidden", "Model promotion requires an admin or policy admin.");
      try {
        const m = promote(db, op.version, op.to, op.percent, user, op.reason || `promoted to ${op.to}`, at);
        audit(db, { at: iso, type: "ml.model_promoted", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "model", id: `orbis-edge-risk@${op.version}` }, summary: `${user.name} moved orbis-edge-risk ${op.version} → ${op.to}${op.to === "canary" ? ` (${m.rollout_percent}%)` : ""}: ${op.reason || "no reason"}`, data: { manifest_seq: db.ml.manifest_seq } });
        emit({ type: "ml.changed", kind: "promote", version: op.version });
        return m;
      } catch (e) {
        const code = (e as Error).message;
        if (code === "gates_not_passed") throw new ApiError(409, "release_gates_failed", `orbis-edge-risk ${op.version} has not passed every release gate; it cannot be deployed.`, "Fix the failing gates and register a new candidate.");
        if (code === "not_forward") throw new ApiError(409, "invalid_transition", "Lifecycle only moves forward (candidate → shadow → canary → production); use rollback to go back.");
        throw new ApiError(404, "not_found", "Unknown model version.");
      }
    }
    case "ml_rollback": {
      const user = userOf(db, op.user_id);
      if (!user.roles.some((r) => ML_ADMIN.includes(r) || r === "responder")) throw new ApiError(403, "forbidden", "Rollback requires an admin, policy admin or responder.");
      try {
        const r = rollback(db, op.version, user, op.reason, at);
        audit(db, { at: iso, type: "ml.model_rolled_back", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "model", id: `orbis-edge-risk@${op.version}` }, summary: `orbis-edge-risk ${op.version} rolled back (${op.reason}); active production ${r.active ?? "none"}`, data: { manifest_seq: db.ml.manifest_seq } });
        emit({ type: "ml.changed", kind: "rollback", version: op.version });
        return r;
      } catch {
        throw new ApiError(409, "not_deployed", "Only a shadow, canary or production model can be rolled back.");
      }
    }
    case "ml_review": {
      const user = userOf(db, op.user_id);
      if (!user.roles.some((r) => ["owner", "admin", "policy_admin", "auditor", "responder"].includes(r))) throw new ApiError(403, "forbidden", "Analyst review requires a security, policy or audit role.");
      const p = db.ml.predictions.find((x) => x.id === op.prediction_id);
      if (!p) throw new ApiError(404, "not_found", "Prediction not found.");
      const fb = { id: id("fb"), prediction_id: p.id, action_id: p.action_id, label: op.label, label_state: "analyst_reviewed" as const, confidence: 0.95, source: "analyst" as const, reviewed_by: user.name, reviewed_at: iso, note: op.note?.slice(0, 300) };
      db.ml.feedback.push(fb);
      audit(db, { at: iso, type: "ml.label_reviewed", actor: { kind: "user", id: user.id, name: user.name }, target: { type: "prediction", id: p.id }, summary: `${user.name} labelled a ${p.class ?? "fallback"} prediction as ${op.label.replace("_", " ")} — enters the next dataset version, not the live model` });
      emit({ type: "ml.changed", kind: "review" });
      return fb;
    }
    case "ml_settings": {
      const user = userOf(db, op.user_id);
      if (!user.roles.some((r) => ML_ADMIN.includes(r) || (op.kill_switch === true && r === "responder"))) throw new ApiError(403, "forbidden", "Changing model escalation requires an admin.");
      const changes: string[] = [];
      if (op.mode && op.mode !== db.ml.fusion.mode) {
        db.ml.fusion = { ...db.ml.fusion, mode: op.mode };
        changes.push(`fusion mode → ${op.mode}`);
      }
      if (typeof op.kill_switch === "boolean" && op.kill_switch !== db.ml.kill_switch) {
        db.ml.kill_switch = op.kill_switch;
        db.ml.manifest_seq += 1;
        changes.push(op.kill_switch ? "model kill switch ENGAGED (deterministic policy only)" : "model kill switch released");
      }
      if (changes.length) {
        audit(db, { at: iso, type: "ml.settings_changed", actor: { kind: "user", id: user.id, name: user.name }, summary: `${user.name}: ${changes.join("; ")}` });
        emit({ type: "ml.changed", kind: "settings" });
      }
      return { fusion: db.ml.fusion, kill_switch: db.ml.kill_switch };
    }
    case "endpoint_checkin": {
      const integration = integrationOf(db, op.integration_id);
      let ep = db.ml.endpoints.find((e) => e.id === op.endpoint_id);
      if (!ep) {
        ep = {
          id: op.endpoint_id, name: op.meta?.name?.slice(0, 80) ?? op.endpoint_id, kind: "agent_host", os: op.meta?.os?.slice(0, 40) ?? "macOS", app_version: op.meta?.app_version?.slice(0, 20) ?? ENDPOINT_APP_VERSION,
          owner: integration.name, integration_id: integration.id, bucket: bucketOf(op.endpoint_id), model_version: null, feature_schema: "edge-features/1", last_update_at: null, last_seen_at: iso, signature: "not_checked", state: "healthy",
          health: { inference_p95_ms: 0, pipeline_p95_ms: 0, memory_mb: 0, cpu_percent: 0, queue_depth: 0, failures_24h: 0, fallbacks_24h: 0 }, telemetry: { events_24h: 0, high_priority_24h: 0, dropped_24h: 0 }, real: !op.drill,
          note: op.drill ? undefined : "Registered by a real orbis-endpoint process.",
        };
        db.ml.endpoints.push(ep);
        audit(db, { at: iso, type: "endpoint.registered", actor: { kind: "integration", id: integration.id, name: integration.name }, target: { type: "endpoint", id: ep.id }, summary: `Endpoint ${ep.name} registered (${ep.os}, app ${ep.app_version})` });
      } else if (ep.integration_id && ep.integration_id !== integration.id && !op.drill) {
        throw new ApiError(403, "endpoint_owned_elsewhere", "This endpoint id belongs to another integration.");
      }
      ep.last_seen_at = iso;
      if (op.meta?.app_version) ep.app_version = op.meta.app_version.slice(0, 20);
      if (op.health) {
        const h = op.health;
        for (const k of ["inference_p95_ms", "pipeline_p95_ms", "memory_mb", "cpu_percent", "queue_depth", "failures_24h", "fallbacks_24h"] as const) {
          if (typeof h[k] === "number" && Number.isFinite(h[k])) ep.health[k] = Math.max(0, h[k]!);
        }
        if (h.active_model !== undefined) ep.model_version = h.active_model;
        ep.state = ep.feature_schema !== "edge-features/1" ? "incompatible" : ep.health.failures_24h > 5 || ep.health.inference_p95_ms > LATENCY_BUDGET_MS ? "degraded" : h.stale_model ? "stale" : "healthy";
      }
      if (op.events) {
        ep.telemetry.events_24h += Math.max(0, op.events.count | 0);
        ep.telemetry.high_priority_24h += Math.max(0, op.events.high_priority | 0);
        ep.telemetry.dropped_24h += Math.max(0, (op.events.dropped ?? 0) | 0);
      }
      // Automatic rollback (blueprint §17.4): a canary endpoint breaching the latency budget or failing inference.
      const roles = roleVersions(db, at.getTime());
      if (roles.canary && ep.model_version === roles.canary.version && (ep.health.inference_p95_ms > LATENCY_BUDGET_MS || ep.health.failures_24h > 5)) {
        const reason = `automatic: ${ep.name} reported ${ep.health.inference_p95_ms > LATENCY_BUDGET_MS ? `p95 ${ep.health.inference_p95_ms.toFixed(1)} ms > ${LATENCY_BUDGET_MS} ms budget` : `${ep.health.failures_24h} inference failures`}`;
        const r = rollback(db, roles.canary.version, { id: "system", name: "Health monitor" }, reason, at, true);
        audit(db, { at: iso, type: "ml.model_rolled_back", actor: { kind: "system", id: "health-monitor", name: "Health monitor" }, target: { type: "model", id: `orbis-edge-risk@${roles.canary.version}` }, summary: `Automatic rollback of canary ${roles.canary.version}: ${reason.slice(11)}; production stays ${r.active}` });
        emit({ type: "ml.changed", kind: "auto_rollback", version: roles.canary.version });
        return { endpoint: ep, auto_rollback: r };
      }
      return { endpoint: ep };
    }
    case "endpoint_activation": {
      const ep = db.ml.endpoints.find((e) => e.id === op.endpoint_id);
      if (!ep) throw new ApiError(404, "unknown_endpoint", "Check in before reporting activations.");
      db.ml.activations.push({ endpoint_id: ep.id, version: op.version, activated: op.activated, error: op.error?.slice(0, 300), at: iso, compile_ms: op.compile_ms });
      if (op.activated) {
        ep.model_version = op.version;
        ep.last_update_at = iso;
        ep.signature = "verified";
      } else if (op.error?.includes("signature")) ep.signature = "failed";
      audit(db, { at: iso, type: op.activated ? "endpoint.model_activated" : "endpoint.model_refused", actor: { kind: "integration", id: op.integration_id, name: ep.name }, target: { type: "endpoint", id: ep.id }, summary: op.activated ? `${ep.name} activated orbis-edge-risk ${op.version}` : `${ep.name} refused ${op.version}: ${op.error}` });
      emit({ type: "ml.changed", kind: "activation", version: op.version });
      return { endpoint: ep };
    }
  }
}

const BOOL_KEYS = ["policy_publish_requires_second_approver", "metadata_only_mode", "scim"] as const;

function patchSettings(db: DB, op: Extract<Op, { kind: "settings" }>, at: Date) {
  const user = userOf(db, op.user_id);
  const body = op.patch;
  const s = db.tenant.settings;
  const changes: string[] = [];
  for (const k of BOOL_KEYS) {
    if (typeof body[k] === "boolean" && s[k] !== body[k]) {
      (s as Record<string, unknown>)[k] = body[k];
      changes.push(`${k}=${body[k]}`);
    }
  }
  if ((body.notification_policy === "minimal_summary" || body.notification_policy === "title_only") && s.notification_policy !== body.notification_policy) {
    s.notification_policy = body.notification_policy;
    changes.push(`notification_policy=${body.notification_policy}`);
  }
  if (typeof body.retention_days === "number" && [30, 90, 365, 2555].includes(body.retention_days) && db.tenant.retention_days !== body.retention_days) {
    db.tenant.retention_days = body.retention_days;
    changes.push(`retention_days=${body.retention_days}`);
  }
  if (changes.length) audit(db, { at: at.toISOString(), type: "settings.changed", actor: { kind: "user", id: user.id, name: user.name }, summary: `Tenant settings changed: ${changes.join(", ")}` });
  return { tenant: db.tenant, changed: changes };
}

/** Apply an op locally, then append it to the shared log so other instances replay it. */
export async function execute<T = unknown>(db: DB, op: Op): Promise<T> {
  const { recordOp, markApplied } = await import("./sync");
  const env: OpEnvelope = { id: id("op"), at: new Date().toISOString(), op };
  const result = applyOp(db, env) as T; // throws on validation errors → nothing recorded
  markApplied(env.id);
  await recordOp(db, env);
  persist();
  return result;
}
