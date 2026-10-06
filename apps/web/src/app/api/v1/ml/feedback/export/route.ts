import { requireUser } from "@/lib/server/auth";
import { ApiError } from "@/lib/server/gateway";
import { handle } from "@/lib/server/http";
import { envelopeToEvent } from "@/lib/ml/edge/adapter";

/**
 * GET /v1/ml/feedback/export — JSONL of reviewed labels with the canonical event each label refers to.
 * Input to `python -m orbis_ml retrain --feedback`. Metadata only: destinations are hashed.
 */
export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  if (!user.roles.some((r) => ["owner", "admin", "policy_admin", "auditor"].includes(r))) throw new ApiError(403, "forbidden", "Export requires an admin or auditor.");
  const approved = new Set(db.approved_destinations.map((d) => d.toLowerCase()));
  const tools = Object.fromEntries(db.actors.map((a) => [a.id, Object.fromEntries(a.tools.map((t) => [t.tool, t.risk_class]))]));
  const lines = db.ml.feedback.flatMap((f) => {
    const a = db.actions.find((x) => x.id === f.action_id);
    if (!a) return [];
    const integration = db.integrations.find((i) => i.id === a.integration_id);
    const event = envelopeToEvent(a.envelope, new Date(a.received_at), { tenant_id: db.tenant.id, approved, tools, managed: integration?.kind !== "sandbox" });
    return [JSON.stringify({ prediction_id: f.prediction_id, label: f.label, label_state: f.label_state, confidence: f.confidence, source: f.source, reviewed_by: f.reviewed_by, reviewed_at: f.reviewed_at, event })];
  });
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": `attachment; filename="orbis-feedback-${new Date().toISOString().slice(0, 10)}.jsonl"`, "Cache-Control": "no-store" } });
});
