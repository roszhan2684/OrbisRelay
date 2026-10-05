import "server-only";
import type { PolicyRule } from "@orbis/policy-core";
import type { ActionEnvelope } from "@orbis/policy-core";
import type { ApiKey, DB, Device, OutcomeStatus, ProtectAnalysis } from "../domain";
import { hashJson, id, withSeededIds } from "./crypto";
import { ApiError, cancelApproval, freezeActor, preflight, reportOutcome, respond, unfreezeActor, type RespondInput } from "./gateway";
import { audit, emit, persist } from "./store";

/**
 * Every state change is an Op. Ops are applied deterministically — ids are derived from the op id and
 * timestamps come from the op — so any instance replaying the shared op log reaches the same state.
 */
export type Op =
  | { kind: "preflight"; integration_id: string; envelope: ActionEnvelope; force?: { route: string; reason: string } }
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
  | { kind: "signin"; user_id: string };

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
        return preflight(db, integrationOf(db, op.integration_id), op.envelope, { ...o, forceApproval: op.force });
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
