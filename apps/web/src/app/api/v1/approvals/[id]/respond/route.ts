import { requireUser } from "@/lib/server/auth";
import { ApiError, respond } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";
import { approvalView } from "@/lib/server/present";

type Ctx = { params: Promise<{ id: string }> };
const DECISIONS = ["approve", "approve_modified", "reject", "safe_alternative"] as const;

/** POST /v1/approvals/{id}/respond — server verifies assignment, state, expiry and step-up before mutation. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user, device_id, channel } = await requireUser(req);
  const body = await readJson<Record<string, unknown>>(req);
  const decision = body.decision as (typeof DECISIONS)[number];
  if (!DECISIONS.includes(decision)) throw new ApiError(422, "validation_error", `decision must be one of ${DECISIONS.join(", ")}`);
  const step = body.step_up as { method?: string; verified?: boolean } | undefined;
  const { approval } = respond(db, id, user, {
    decision,
    alternative_id: typeof body.alternative_id === "string" ? body.alternative_id : undefined,
    modified_parameters: body.modified_parameters && typeof body.modified_parameters === "object" ? (body.modified_parameters as Record<string, number>) : undefined,
    comment: typeof body.comment === "string" ? body.comment : undefined,
    step_up: step ? { method: step.method === "biometric" ? "biometric" : step.method === "passkey" ? "passkey" : "none", verified: step.verified === true, device_id } : undefined,
    channel,
    unnecessary: body.unnecessary === true,
  });
  return json(approvalView(db, approval, user));
});
