import { requireUser } from "@/lib/server/auth";
import { computeAnalytics } from "@/lib/server/analytics";
import { handle, json } from "@/lib/server/http";

export const GET = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 28)));
  return json(computeAnalytics(db, days));
});
