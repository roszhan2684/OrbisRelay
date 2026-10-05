import { requireUser } from "@/lib/server/auth";
import { id } from "@/lib/server/crypto";
import { ApiError } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";
import { analyzeText, analyzeUrl } from "@/lib/ml/analyzer";
import type { ProtectAnalysis } from "@/lib/domain";

const KINDS = ["url", "text", "qr", "screenshot"] as const;

/** POST /v1/protect/analyze — explicit, user-submitted URL/text/QR/screenshot-text risk analysis. */
export const POST = handle(async (req: Request) => {
  const { db, user, channel } = await requireUser(req);
  const body = await readJson(req);
  const kind = body.kind as (typeof KINDS)[number];
  if (!KINDS.includes(kind)) throw new ApiError(422, "validation_error", `kind must be one of ${KINDS.join(", ")}`);
  const input = String(body.input ?? "").trim();
  if (!input || input.length > 4000) throw new ApiError(422, "validation_error", "input must be 1–4000 characters of user-shared content.");
  const res = kind === "url" || kind === "qr" ? analyzeUrl(input, db.approved_destinations) : analyzeText(input, db.approved_destinations);
  const analysis: ProtectAnalysis = {
    id: id("pa"),
    tenant_id: user.tenant_id,
    user_id: user.id,
    kind,
    input_preview: input.slice(0, 160),
    verdict: res.verdict,
    score: res.score,
    recommendation: res.recommendation,
    reasons: res.reasons,
    model: res.model,
    policy_note: res.policy_note,
    created_at: new Date().toISOString(),
    channel,
  };
  await execute(db, { kind: "protect", analysis });
  return json(analysis, { status: 201 });
});
