import "server-only";
import type { ActionRecord, ApprovalRecord, DB, User } from "../domain";
import { actionTitle, canRespond, latestReceipt } from "./gateway";

/** Canonical decision response (blueprint §7.3). */
export function decisionResponse(db: DB, action: ActionRecord, approval?: ApprovalRecord, replay = false) {
  const ev = action.evaluation;
  return {
    decision_id: action.decision_id,
    action_id: action.id,
    request_id: action.request_id,
    status: ev.status,
    final_status: action.final_status,
    effect: ev.effect,
    frozen: ev.frozen,
    mode: action.mode,
    risk: { score: ev.risk.score, level: ev.risk.level, reasons: ev.risk.reasons.map((r) => r.label) },
    policy: ev.deciding ? { id: ev.deciding.policy_id, name: ev.deciding.policy_name, version: ev.deciding.version, rule_id: ev.deciding.rule_id, reason: ev.deciding.reason } : null,
    approval: approval
      ? {
          id: approval.id,
          status: approval.status,
          route: approval.route,
          expires_at: approval.expires_at,
          step_up: approval.step_up,
          quorum: approval.quorum ?? null,
          status_url: `/api/v1/approvals/${approval.id}`,
        }
      : null,
    safe_alternatives: approval?.safe_alternatives.map((s) => ({ id: s.id, type: s.type, label: s.label, description: s.description })) ?? [],
    approved_parameters: action.approved_parameters ?? null,
    safe_alternative_applied: action.safe_alternative_applied ?? null,
    receipt_id: action.receipt_id ?? null,
    receipt_verification_url: action.receipt_id ? `/api/v1/receipts/${action.receipt_id}/verify` : null,
    latency_ms: action.latency_ms,
    idempotent_replay: replay,
    ml: mlView(db, action),
  };
}

/** Advisory ML evidence on the decision response — never an authorization by itself. */
export function mlView(db: DB, action: ActionRecord) {
  const p = action.prediction_id ? db.ml.predictions.find((x) => x.id === action.prediction_id) : undefined;
  if (!p) return null;
  return {
    prediction_id: p.id,
    source: p.source,
    model: p.model_version ? `orbis-edge-risk@${p.model_version}` : null,
    feature_schema: p.feature_schema,
    class: p.class,
    risk: p.risk === null ? null : Math.round(p.risk * 10_000) / 10_000,
    abstain: p.abstain,
    reasons: p.reasons,
    explanation: p.explanation,
    anomaly: p.anomaly.sufficient ? Math.round(p.anomaly.score * 1000) / 1000 : null,
    deterministic_status: p.deterministic_status,
    fusion: p.fusion,
    fallback: p.fallback ?? null,
    local: p.local ?? null,
  };
}

export function approvalView(db: DB, ap: ApprovalRecord, user?: User) {
  const action = db.actions.find((a) => a.id === ap.action_id);
  const approving = ap.responses.filter((r) => r.decision !== "reject").length;
  return {
    ...ap,
    final_status: action?.final_status,
    receipt_id: action?.receipt_id ?? null,
    approved_parameters: action?.approved_parameters ?? null,
    outcome: action?.outcome ?? null,
    quorum_progress: ap.quorum ? { approvals: approving, required: ap.quorum.required, of: ap.quorum.of } : null,
    can_respond: user ? ap.status === "pending" && canRespond(db, ap, user) && !ap.responses.some((r) => r.user_id === user.id) : false,
    my_response: user ? (ap.responses.find((r) => r.user_id === user.id) ?? null) : null,
    // Push payloads only ever carry this minimal, non-sensitive summary (blueprint §8.4).
    notification: { title: "Action paused — needs approval", body: `${ap.title} · ${ap.risk.level} risk`, deep_link: `orbis://approval/${ap.id}` },
  };
}

export function actionSummary(db: DB, a: ActionRecord) {
  const integration = db.integrations.find((i) => i.id === a.integration_id);
  const actor = db.actors.find((x) => x.id === a.envelope.actor.id);
  return {
    id: a.id,
    title: actionTitle(a.envelope),
    action_type: a.envelope.action.type,
    tool: a.envelope.action.tool,
    actor: { id: a.envelope.actor.id, type: a.envelope.actor.type, name: actor?.name ?? a.envelope.actor.display_name ?? a.envelope.actor.id },
    integration: { id: a.integration_id, name: integration?.name ?? a.integration_id },
    received_at: a.received_at,
    final_status: a.final_status,
    effect: a.evaluation.effect,
    risk: { score: a.evaluation.risk.score, level: a.evaluation.risk.level },
    rule: a.evaluation.deciding?.rule_name ?? null,
    policy_id: a.evaluation.deciding?.policy_id ?? null,
    outcome: a.outcome?.status ?? null,
    mode: a.mode,
    approval_id: a.approval_id ?? null,
    receipt_id: a.receipt_id ?? null,
    latency_ms: a.latency_ms,
    amount_usd: a.envelope.business_context?.amount_usd ?? null,
  };
}

export function receiptView(db: DB, receiptId: string, tenantId: string) {
  const r = latestReceipt(db, receiptId, tenantId);
  if (!r) return null;
  const history = db.receipts.filter((x) => x.id === receiptId).sort((a, b) => a.revision - b.revision);
  return { ...r, revisions: history.map((h) => ({ revision: h.revision, body_hash: h.body_hash, issued_at: h.body.issued_at })) };
}
