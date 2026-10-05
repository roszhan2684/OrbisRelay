import { requireIntegration, requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";

/** GET /v1/policies — list policies with their version history. */
export const GET = handle(async (req: Request) => {
  const machine = (req.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer orb_");
  const { db } = machine ? await requireIntegration(req) : await requireUser(req);
  return json({ data: db.policies });
});
