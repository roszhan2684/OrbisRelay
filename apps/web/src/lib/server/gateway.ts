import "server-only";
import {
  evaluate,
  publishedVersion,
  type ActionEnvelope,
  type EvaluationContext,
  type EvidenceItem,
  type Policy,
  type PolicyVersion,
} from "@orbis/policy-core";
import type {
  ActionRecord,
  ApprovalRecord,
  ApprovalResponse,
  DB,
  FinalStatus,
  Freeze,
  Integration,
  OutcomeStatus,
  Receipt,
  ReceiptBody,
  User,
} from "../domain";
import { hashJson, id, signCanonical, verifyCanonical } from "./crypto";
import { audit, emit, persist } from "./store";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public remediation?: string,
  ) {
    super(message);
  }
}

export interface OpOptions {
  at?: Date;
  /** Seed mode: no live events, no persistence. */
  silent?: boolean;
}

const nowOf = (o?: OpOptions) => o?.at ?? new Date();

// ---------------------------------------------------------------- policy context

export function liveVersions(db: DB): Array<{ policy: Pick<Policy, "id" | "name">; version: PolicyVersion }> {
  return db.policies
    .filter((p) => p.enabled)
    .map((p) => ({ policy: p, version: publishedVersion(p) }))
    .filter((x): x is { policy: Policy; version: PolicyVersion } => !!x.version);
}

export function frozenActorIds(db: DB) {
  return new Set(db.freezes.filter((f) => !f.lifted_at).map((f) => f.actor_id));
}

export function contextFor(db: DB, at: Date): EvaluationContext {
  return {
    now: at,
    frozenActors: frozenActorIds(db),
    approvedDestinations: new Set(db.approved_destinations),
    knownDestinations: new Set(db.known_destinations),
    actorTrust: Object.fromEntries(db.actors.map((a) => [a.id, a.trust])),
    businessHours: { ...db.tenant.settings.business_hours, timezoneOffsetMinutes: -240 },
  };
}

// ---------------------------------------------------------------- presentation helpers

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function actionTitle(env: ActionEnvelope): string {
  if (env.action.title) return env.action.title;
  const bc = env.business_context ?? {};
  const count = env.resources.reduce((s, r) => s + (r.count ?? 1), 0);
  switch (env.action.type) {
    case "refund":
      return `Refund ${usd(Number(bc.amount_usd ?? 0))}`;
    case "payment":
      return `Pay ${env.destination?.value ?? "vendor"} ${usd(Number(bc.amount_usd ?? 0))}`;
    case "deploy":
      return `Deploy ${env.resources[0]?.label ?? env.resources[0]?.id ?? "service"} to ${env.resources[0]?.environment ?? "production"}`;
    case "grant_access":
      return `Grant ${env.resources[0]?.label ?? "admin"} for ${bc.duration_minutes ?? 30} min`;
    case "data_export":
      return `Export ${Number(bc.record_count ?? count).toLocaleString("en-US")} records`;
    case "external_send":
      return `Send ${count} ${env.resources[0]?.type ?? "item"}${count === 1 ? "" : "s"} to ${env.destination?.value ?? "external"}`;
    case "email_send":
      return `Email ${env.destination?.value ?? "recipient"}`;
    case "record_release":
      return `Release ${Number(bc.record_count ?? count).toLocaleString("en-US")} records`;
    case "operational_stop":
      return `Stop ${env.resources[0]?.label ?? "system"}`;
    default:
      return env.action.tool ? `Call ${env.action.tool}` : env.action.type.replace(/_/g, " ");
  }
}

function deriveEvidence(env: ActionEnvelope, facts: Record<string, unknown>): EvidenceItem[] {
  const ev: EvidenceItem[] = [...(env.evidence ?? [])];
  const push = (label: string, value: string, source = "Action envelope") => {
    if (!ev.some((e) => e.label === label)) ev.push({ id: `ev_${ev.length + 1}`, label, value, source, freshness: "at request", confidence: "high", kind: "fact" });
  };
  if (env.destination) push("Destination", `${env.destination.value} (${env.destination.type.replace(/_/g, " ")})${facts["destination.approved"] ? " · allowlisted" : " · not allowlisted"}`);
  if (facts["resource.classification"]) push("Data class", String(facts["resource.classification"]));
  if (env.business_context?.amount_usd !== undefined) push("Amount", usd(Number(env.business_context.amount_usd)));
  if (env.business_context?.record_count !== undefined) push("Records", Number(env.business_context.record_count).toLocaleString("en-US"));
  if (facts["resource.environment"]) push("Environment", String(facts["resource.environment"]));
  return ev;
}

// ---------------------------------------------------------------- preflight

export interface PreflightResult {
  action: ActionRecord;
  approval?: ApprovalRecord;
  idempotent_replay: boolean;
}

export function preflight(
  db: DB,
  integration: Integration,
  envelope: ActionEnvelope,
  opts: OpOptions & { forceApproval?: { route: string; reason: string } } = {},
): PreflightResult {
  const at = nowOf(opts);
  const existing = db.actions.find((a) => a.integration_id === integration.id && a.request_id === envelope.request_id);
  if (existing) {
    const same = existing.envelope_hash === hashJson(envelope);
    if (!same) throw new ApiError(409, "idempotency_conflict", "request_id was already used with a different payload.", "Generate a new request_id per distinct action.");
    return { action: existing, approval: db.approvals.find((p) => p.id === existing.approval_id), idempotent_replay: true };
  }

  const started = performance.now();
  const evaluation = evaluate(envelope, liveVersions(db), contextFor(db, at));
  // Seeding uses a deterministic latency so every instance builds identical history.
  const measured = opts.silent ? 0 : performance.now() - started;
  const latency = Math.max(4, Math.round(measured + 6 + (envelope.request_id.charCodeAt(envelope.request_id.length - 1) % 11)));

  let status = evaluation.status;
  let effect = evaluation.effect;
  let approvalSpec = evaluation.approval;
  if (opts.forceApproval && status !== "deny") {
    status = "approval_required";
    effect = "require_approval";
    approvalSpec ??= { route: opts.forceApproval.route, step_up: "none", ttl_seconds: envelope.ttl_seconds ?? 900, editable_fields: [] };
  }

  const observe = integration.mode === "observe";
  const action: ActionRecord = {
    id: id("act"),
    tenant_id: db.tenant.id,
    integration_id: integration.id,
    request_id: envelope.request_id,
    envelope,
    envelope_hash: hashJson(envelope),
    received_at: at.toISOString(),
    decided_at: new Date(at.getTime() + latency).toISOString(),
    latency_ms: latency,
    mode: integration.mode,
    evaluation: {
      status,
      effect,
      frozen: evaluation.frozen,
      risk: evaluation.risk,
      matched: evaluation.matched,
      deciding: evaluation.deciding,
      policy_versions: liveVersions(db).map((v) => ({ policy_id: v.policy.id, version: v.version.version })),
    },
    decision_id: id("dec"),
    final_status: observe ? (status === "approval_required" ? "warn" : status) : status === "approval_required" ? "pending" : status,
  };
  db.actions.push(action);
  for (const d of [envelope.destination?.value?.toLowerCase()].filter(Boolean) as string[]) {
    if (!db.known_destinations.includes(d)) db.known_destinations.push(d);
  }
  integration.last_seen_at = at.toISOString();
  integration.first_protected_at ??= at.toISOString();
  db.tenant.usage.decisions_this_month += 1;

  if (evaluation.frozen) {
    const fr = db.freezes.find((f) => f.actor_id === envelope.actor.id && !f.lifted_at);
    if (fr) fr.blocked_count += 1;
  }

  const sysActor = { kind: "integration" as const, id: integration.id, name: integration.name };
  audit(db, {
    at: action.received_at,
    type: "action.evaluated",
    actor: sysActor,
    target: { type: "action", id: action.id },
    summary: `${actionTitle(envelope)} → ${observe ? `observed (${status})` : status}${evaluation.deciding ? ` · ${evaluation.deciding.rule_name} v${evaluation.deciding.version}` : ""}`,
    data: { risk: evaluation.risk.score, effect, envelope_hash: action.envelope_hash },
  });

  let approval: ApprovalRecord | undefined;
  if (status === "approval_required" && approvalSpec && !observe) {
    const deciding = evaluation.deciding ?? {
      policy_id: "manual",
      policy_name: "Explicit approval request",
      version: 1,
      rule_id: "explicit",
      rule_name: "Caller-requested approval",
      effect: "require_approval" as const,
      reason: opts.forceApproval?.reason ?? "The calling workflow requested human approval.",
    };
    const assignees = db.users.filter((u) => u.status === "active" && u.groups.includes(approvalSpec.route)).map((u) => u.id);
    const actorRec = db.actors.find((a) => a.id === envelope.actor.id);
    approval = {
      id: id("apr"),
      tenant_id: db.tenant.id,
      action_id: action.id,
      title: actionTitle(envelope),
      summary: envelope.action.arguments_summary ?? deciding.reason,
      intent: envelope.intent?.reason,
      route: approvalSpec.route,
      assignees,
      status: "pending",
      step_up: approvalSpec.step_up,
      quorum: approvalSpec.quorum,
      created_at: action.decided_at,
      expires_at: new Date(at.getTime() + approvalSpec.ttl_seconds * 1000).toISOString(),
      escalation_level: 0,
      responses: [],
      editable_fields: approvalSpec.editable_fields,
      safe_alternatives: evaluation.safe_alternatives,
      evidence: deriveEvidence(envelope, evaluation.facts as Record<string, unknown>),
      blast_radius: envelope.blast_radius ?? [],
      risk: evaluation.risk,
      policy: {
        id: deciding.policy_id,
        name: deciding.policy_name,
        version: deciding.version,
        rule_id: deciding.rule_id,
        rule_name: deciding.rule_name,
        reason: deciding.reason,
      },
      actor: { id: envelope.actor.id, type: envelope.actor.type, name: actorRec?.name ?? envelope.actor.display_name ?? envelope.actor.id },
      integration: { id: integration.id, name: integration.name },
      parameters: envelope.action.parameters ?? {},
    };
    db.approvals.push(approval);
    action.approval_id = approval.id;
    audit(db, {
      at: approval.created_at,
      type: "approval.created",
      actor: { kind: "system", id: "orchestrator", name: "Approval orchestrator" },
      target: { type: "approval", id: approval.id },
      summary: `Routed "${approval.title}" to ${approval.route} (${assignees.length} approvers${approval.quorum ? `, quorum ${approval.quorum.required}/${approval.quorum.of}` : ""}${approval.step_up === "biometric" ? ", biometric step-up" : ""})`,
    });
  } else {
    issueReceipt(db, action, at);
    deliverWebhook(db, integration, "decision.final", action, at);
  }

  if (!opts.silent) {
    emit({ type: "action.created", action_id: action.id, status: action.final_status, title: actionTitle(envelope) });
    if (approval) emit({ type: "approval.created", approval_id: approval.id, title: approval.title, risk: approval.risk.level });
    persist();
  }
  return { action, approval, idempotent_replay: false };
}

// ---------------------------------------------------------------- approval responses

export interface RespondInput {
  decision: ApprovalResponse["decision"];
  alternative_id?: string;
  modified_parameters?: Record<string, string | number | boolean>;
  comment?: string;
  step_up?: { method: "biometric" | "passkey" | "none"; verified: boolean; device_id?: string };
  channel: "ios" | "web";
  unnecessary?: boolean;
}

export function canRespond(db: DB, approval: ApprovalRecord, user: User) {
  return user.tenant_id === approval.tenant_id && user.status === "active" && (approval.assignees.includes(user.id) || user.groups.includes(approval.route));
}

export function respond(db: DB, approvalId: string, user: User, input: RespondInput, opts: OpOptions = {}) {
  const at = nowOf(opts);
  const approval = db.approvals.find((a) => a.id === approvalId && a.tenant_id === user.tenant_id);
  if (!approval) throw new ApiError(404, "not_found", "Approval not found.");
  if (!canRespond(db, approval, user)) throw new ApiError(403, "not_assigned", "You are not an assigned approver for this request.");
  if (approval.status === "pending" && new Date(approval.expires_at) <= at) expireApproval(db, approval, at, opts);
  if (approval.status === "expired") throw new ApiError(410, "expired", "This approval expired before a decision was recorded.");
  if (approval.status !== "pending") throw new ApiError(409, "already_resolved", `This approval is already ${approval.status.replace("_", " ")}.`);
  if (approval.responses.some((r) => r.user_id === user.id)) throw new ApiError(409, "already_responded", "You already responded to this approval.");

  const approving = input.decision !== "reject";
  if (approving && approval.step_up === "biometric") {
    const s = input.step_up;
    if (!s || !s.verified || s.method === "none") {
      throw new ApiError(428, "step_up_required", "This action requires biometric step-up verification before approval.", "Complete Face ID (iOS) or passkey verification (web) and resubmit.");
    }
    if (input.channel === "ios") {
      const device = db.devices.find((d) => d.id === s.device_id && d.user_id === user.id);
      if (!device || device.trust === "revoked") throw new ApiError(403, "device_not_trusted", "Step-up must come from a registered, non-revoked device.");
    }
  }

  let modified: Record<string, string | number | boolean> | undefined;
  if (input.decision === "approve_modified") {
    modified = input.modified_parameters ?? {};
    for (const [k, v] of Object.entries(modified)) {
      const field = approval.editable_fields.find((f) => f.key === k);
      if (!field) throw new ApiError(422, "field_not_editable", `"${k}" is not editable for this approval.`);
      if (field.type === "number" || field.type === "duration_minutes") {
        if (typeof v !== "number" || !Number.isFinite(v)) throw new ApiError(422, "invalid_value", `${field.label} must be a number.`);
        const max = field.max ?? (typeof approval.parameters[k] === "number" ? (approval.parameters[k] as number) : undefined);
        if (field.min !== undefined && v < field.min) throw new ApiError(422, "out_of_range", `${field.label} must be ≥ ${field.min}.`);
        if (max !== undefined && v > max) throw new ApiError(422, "out_of_range", `${field.label} must be ≤ ${max}.`);
      }
    }
  }
  let alternative;
  if (input.decision === "safe_alternative") {
    alternative = approval.safe_alternatives.find((s) => s.id === input.alternative_id);
    if (!alternative) throw new ApiError(422, "unknown_alternative", "That safe alternative is not offered for this approval.");
  }

  const response: ApprovalResponse = {
    id: id("rsp"),
    user_id: user.id,
    user_name: user.name,
    decision: input.decision,
    alternative_id: alternative?.id,
    modified_parameters: modified,
    comment: input.comment?.slice(0, 500),
    step_up: input.step_up ?? { method: "none", verified: false },
    channel: input.channel,
    responded_at: at.toISOString(),
    unnecessary: input.unnecessary,
  };
  approval.responses.push(response);
  audit(db, {
    at: response.responded_at,
    type: "approval.response",
    actor: { kind: "user", id: user.id, name: user.name },
    target: { type: "approval", id: approval.id },
    summary: `${user.name} ${input.decision === "reject" ? "rejected" : input.decision === "safe_alternative" ? `chose "${alternative?.label}"` : input.decision === "approve_modified" ? "edited & approved" : "approved"} "${approval.title}" via ${input.channel}${response.step_up.verified ? ` · ${response.step_up.method} verified` : ""}`,
  });

  // Resolution: any rejection rejects; otherwise wait for quorum.
  const action = db.actions.find((a) => a.id === approval.action_id)!;
  if (input.decision === "reject") {
    finalize(db, approval, action, "rejected", at, opts);
  } else {
    const approvals = approval.responses.filter((r) => r.decision !== "reject");
    const needed = approval.quorum?.required ?? 1;
    if (approvals.length >= needed) {
      const mod = [...approvals].reverse().find((r) => r.decision === "approve_modified" || r.decision === "safe_alternative");
      if (mod) {
        const alt = approval.safe_alternatives.find((s) => s.id === mod.alternative_id);
        action.approved_parameters = { ...approval.parameters, ...(mod.modified_parameters ?? {}), ...(alt?.apply ?? {}) };
        action.safe_alternative_applied = alt?.id;
        finalize(db, approval, action, "approved_modified", at, opts);
      } else {
        action.approved_parameters = { ...approval.parameters };
        finalize(db, approval, action, "approved", at, opts);
      }
    } else if (!opts.silent) {
      persist();
    }
  }
  return { approval, action };
}

function finalize(db: DB, approval: ApprovalRecord, action: ActionRecord, status: Exclude<FinalStatus, "allow" | "warn" | "deny" | "pending">, at: Date, opts: OpOptions) {
  approval.status = status as ApprovalRecord["status"];
  approval.resolved_at = at.toISOString();
  action.final_status = status;
  issueReceipt(db, action, at);
  const integration = db.integrations.find((i) => i.id === action.integration_id);
  if (integration) deliverWebhook(db, integration, "approval.resolved", action, at);
  audit(db, {
    at: at.toISOString(),
    type: "approval.resolved",
    actor: { kind: "system", id: "orchestrator", name: "Approval orchestrator" },
    target: { type: "approval", id: approval.id },
    summary: `"${approval.title}" ${status.replace("_", " ")} · receipt ${action.receipt_id}`,
  });
  if (!opts.silent) {
    emit({ type: "approval.resolved", approval_id: approval.id, status });
    persist();
  }
}

function expireApproval(db: DB, approval: ApprovalRecord, at: Date, opts: OpOptions) {
  const action = db.actions.find((a) => a.id === approval.action_id)!;
  finalize(db, approval, action, "expired", at, opts);
}

export function cancelApproval(db: DB, approvalId: string, integration: Integration) {
  const approval = db.approvals.find((a) => a.id === approvalId && a.tenant_id === integration.tenant_id && a.integration.id === integration.id);
  if (!approval) throw new ApiError(404, "not_found", "Approval not found.");
  if (approval.status !== "pending") throw new ApiError(409, "already_resolved", "Approval already resolved.");
  const action = db.actions.find((a) => a.id === approval.action_id)!;
  finalize(db, approval, action, "cancelled", new Date(), {});
  return approval;
}

/** Background lifecycle: expire stale approvals and escalate ones past half their TTL. */
export function tick(db: DB, at = new Date(), opts: OpOptions = {}) {
  let changed = false;
  for (const a of db.approvals) {
    if (a.status !== "pending") continue;
    const created = new Date(a.created_at).getTime();
    const expires = new Date(a.expires_at).getTime();
    if (expires <= at.getTime()) {
      expireApproval(db, a, at, opts);
      changed = true;
    } else if (a.escalation_level === 0 && at.getTime() - created > (expires - created) * 0.5) {
      a.escalation_level = 1;
      a.escalated_at = at.toISOString();
      audit(db, {
        at: a.escalated_at,
        type: "approval.escalated",
        actor: { kind: "system", id: "orchestrator", name: "Approval orchestrator" },
        target: { type: "approval", id: a.id },
        summary: `SLA at 50% for "${a.title}" — escalated to secondary approvers in ${a.route}`,
      });
      if (!opts.silent) emit({ type: "approval.escalated", approval_id: a.id });
      changed = true;
    }
  }
  if (changed && !opts.silent) persist();
}

// ---------------------------------------------------------------- receipts

export function issueReceipt(db: DB, action: ActionRecord, at: Date) {
  const integration = db.integrations.find((i) => i.id === action.integration_id);
  const approval = db.approvals.find((a) => a.id === action.approval_id);
  const prev = db.receipts.filter((r) => r.action_id === action.id).sort((a, b) => b.revision - a.revision)[0];
  const receiptId = prev?.id ?? id("rcp");
  const ev = action.evaluation;
  const body: ReceiptBody = {
    receipt_id: receiptId,
    revision: (prev?.revision ?? 0) + 1,
    tenant_id: action.tenant_id,
    decision_id: action.decision_id,
    action_id: action.id,
    request_id: action.request_id,
    issued_at: at.toISOString(),
    caller: { integration_id: action.integration_id, integration_name: integration?.name ?? action.integration_id },
    actor: { id: action.envelope.actor.id, type: action.envelope.actor.type, owner: action.envelope.actor.owner },
    action: { type: action.envelope.action.type, tool: action.envelope.action.tool, title: actionTitle(action.envelope), summary: action.envelope.action.arguments_summary },
    envelope_hash: action.envelope_hash,
    policy: ev.deciding ? { id: ev.deciding.policy_id, version: ev.deciding.version, rule_id: ev.deciding.rule_id } : null,
    policy_versions: ev.policy_versions,
    risk: { score: ev.risk.score, level: ev.risk.level, reasons: ev.risk.reasons.map((r) => r.code) },
    enrichment: { used: false },
    decision: { status: ev.status, effect: ev.effect, final_status: action.final_status },
    approvals: (approval?.responses ?? []).map((r) => ({
      user_id: r.user_id,
      name: r.user_name,
      decision: r.decision,
      step_up: r.step_up.verified ? r.step_up.method : "none",
      device_id: r.step_up.device_id,
      at: r.responded_at,
      channel: r.channel,
    })),
    original_parameters: action.envelope.action.parameters ?? {},
    approved_parameters: action.approved_parameters,
    safe_alternative_applied: action.safe_alternative_applied,
    timestamps: { received_at: action.received_at, decided_at: action.decided_at, resolved_at: approval?.resolved_at },
    outcome: action.outcome ? { status: action.outcome.status, reported_at: action.outcome.reported_at } : undefined,
    prev_hash: prev?.body_hash,
  };
  const receipt: Receipt = {
    id: receiptId,
    tenant_id: action.tenant_id,
    action_id: action.id,
    revision: body.revision,
    body,
    body_hash: hashJson(body),
    signature: signCanonical(db.signing_key.private_pem, body),
    key_id: db.signing_key.id,
    alg: "Ed25519",
  };
  db.receipts.push(receipt);
  action.receipt_id = receiptId;
  return receipt;
}

export function latestReceipt(db: DB, receiptId: string, tenantId: string) {
  return db.receipts.filter((r) => r.id === receiptId && r.tenant_id === tenantId).sort((a, b) => b.revision - a.revision)[0];
}

export function verifyReceipt(db: DB, r: Pick<Receipt, "body" | "signature" | "body_hash">) {
  const sigOk = verifyCanonical(db.signing_key.public_pem, r.body, r.signature);
  const hashOk = hashJson(r.body) === r.body_hash;
  return { valid: sigOk && hashOk, signature_valid: sigOk, hash_valid: hashOk, key_id: db.signing_key.id, alg: "Ed25519" };
}

// ---------------------------------------------------------------- outcomes

export function reportOutcome(db: DB, actionId: string, integration: Integration, status: OutcomeStatus, detail: string | undefined, opts: OpOptions = {}) {
  const at = nowOf(opts);
  const action = db.actions.find((a) => a.id === actionId && a.tenant_id === integration.tenant_id && a.integration_id === integration.id);
  if (!action) throw new ApiError(404, "not_found", "Action not found for this integration.");
  if (action.outcome) {
    if (action.outcome.status === status) return { action, idempotent_replay: true };
    throw new ApiError(409, "outcome_already_reported", `Outcome already reported as ${action.outcome.status}.`);
  }
  if (action.final_status === "pending") throw new ApiError(409, "not_final", "Action is still awaiting a decision.");
  const authorized = ["allow", "warn", "approved", "approved_modified"].includes(action.final_status);
  if (!authorized && status === "succeeded") {
    audit(db, {
      at: at.toISOString(),
      type: "security.unauthorized_execution",
      actor: { kind: "integration", id: integration.id, name: integration.name },
      target: { type: "action", id: action.id },
      summary: `Caller reported execution of a ${action.final_status} action — flagged for review`,
    });
  }
  action.outcome = { status, reported_at: at.toISOString(), detail: detail?.slice(0, 300) };
  issueReceipt(db, action, at);
  audit(db, {
    at: at.toISOString(),
    type: "action.outcome",
    actor: { kind: "integration", id: integration.id, name: integration.name },
    target: { type: "action", id: action.id },
    summary: `Outcome ${status} for "${actionTitle(action.envelope)}"`,
  });
  if (!opts.silent) {
    emit({ type: "outcome.reported", action_id: action.id, status });
    persist();
  }
  return { action, idempotent_replay: false };
}

// ---------------------------------------------------------------- freeze

export function freezeActor(db: DB, actorId: string, user: User, reason: string, channel: Freeze["channel"], opts: OpOptions = {}) {
  const at = nowOf(opts);
  if (!user.roles.some((r) => r === "responder" || r === "admin" || r === "owner")) throw new ApiError(403, "forbidden", "Only responders or admins can freeze actors.");
  const actor = db.actors.find((a) => a.id === actorId && a.tenant_id === user.tenant_id);
  if (!actor) throw new ApiError(404, "not_found", "Actor not found.");
  const active = db.freezes.find((f) => f.actor_id === actorId && !f.lifted_at);
  if (active) return active;
  const fr: Freeze = { id: id("frz"), tenant_id: user.tenant_id, actor_id: actorId, reason: reason.slice(0, 280) || "Emergency freeze", created_by: user.id, created_at: at.toISOString(), channel, blocked_count: 0 };
  db.freezes.push(fr);
  for (const ap of db.approvals.filter((a) => a.status === "pending" && a.actor.id === actorId)) {
    const action = db.actions.find((a) => a.id === ap.action_id)!;
    finalize(db, ap, action, "cancelled", at, opts);
  }
  audit(db, {
    at: fr.created_at,
    type: "freeze.created",
    actor: { kind: "user", id: user.id, name: user.name },
    target: { type: "actor", id: actorId },
    summary: `${user.name} froze ${actor.name} via ${channel}: ${fr.reason}`,
  });
  if (!opts.silent) {
    emit({ type: "freeze.changed", actor_id: actorId, frozen: true });
    persist();
  }
  return fr;
}

export function unfreezeActor(db: DB, actorId: string, user: User, reason: string, opts: OpOptions = {}) {
  const at = nowOf(opts);
  if (!user.roles.some((r) => r === "admin" || r === "owner")) throw new ApiError(403, "forbidden", "Only admins can lift a freeze.");
  if (!reason || reason.trim().length < 4) throw new ApiError(422, "reason_required", "A reason is required to lift a freeze.");
  const fr = db.freezes.find((f) => f.actor_id === actorId && !f.lifted_at && f.tenant_id === user.tenant_id);
  if (!fr) throw new ApiError(404, "not_frozen", "Actor is not frozen.");
  fr.lifted_at = at.toISOString();
  fr.lifted_by = user.id;
  fr.lift_reason = reason.slice(0, 280);
  const actor = db.actors.find((a) => a.id === actorId);
  audit(db, {
    at: fr.lifted_at,
    type: "freeze.lifted",
    actor: { kind: "user", id: user.id, name: user.name },
    target: { type: "actor", id: actorId },
    summary: `${user.name} restored ${actor?.name ?? actorId}: ${fr.lift_reason}`,
  });
  if (!opts.silent) {
    emit({ type: "freeze.changed", actor_id: actorId, frozen: false });
    persist();
  }
  return fr;
}

// ---------------------------------------------------------------- webhooks

export function deliverWebhook(db: DB, integration: Integration, event: string, action: ActionRecord, at: Date) {
  const ep = db.webhooks.find((w) => w.id === integration.webhook_id);
  if (!ep || ep.status === "disabled") return;
  const failing = ep.status === "failing";
  const seed = action.id.charCodeAt(5) + action.id.charCodeAt(7);
  db.deliveries.push({
    id: id("whd"),
    endpoint_id: ep.id,
    event,
    action_id: action.id,
    status_code: failing && seed % 3 !== 0 ? 503 : 200,
    attempt: failing && seed % 3 !== 0 ? 1 + (seed % 4) : 1,
    delivered_at: new Date(at.getTime() + 40 + (seed % 200)).toISOString(),
    duration_ms: 38 + (seed % 180),
  });
}

/** SSRF guard for customer callback URLs (blueprint §19.3). */
export function validateCallbackUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "Callback URLs must use https." };
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return { ok: false, reason: "Internal hostnames are not allowed." };
  if (/^(10\.|127\.|169\.254\.|192\.168\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[")) return { ok: false, reason: "Private, loopback and link-local addresses are not allowed." };
  if (u.username || u.password) return { ok: false, reason: "Credentials in URLs are not allowed." };
  return { ok: true as const };
}
