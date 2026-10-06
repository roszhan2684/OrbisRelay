import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";
import { reviewQueue } from "@/lib/server/ml";

/** GET /v1/ml/review — active-review queue (uncertain, policy/model disagreement, novel, high impact). */
export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  const q = reviewQueue(db, 80);
  return json({ total: q.total, items: q.items.map(({ p, why, priority }) => ({ prediction: p, why, priority, action: db.actions.find((a) => a.id === p.action_id)?.envelope.action })) });
});
