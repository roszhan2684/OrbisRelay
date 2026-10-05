import { requireUser } from "@/lib/server/auth";
import type { Freeze } from "@/lib/domain";
import { execute } from "@/lib/server/ops";
import { handle, json, readJson } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/actors/{id}/freeze — emergency stop; the gateway denies all new requests immediately. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user, channel } = await requireUser(req);
  const body = await readJson(req);
  const fr = await execute<Freeze>(db, { kind: "freeze", actor_id: id, user_id: user.id, reason: String(body.reason ?? "Emergency freeze"), channel: channel === "ios" ? "ios" : "web" });
  return json(fr, { status: 201 });
});

/** DELETE /v1/actors/{id}/freeze — restore with permission and an audit reason. */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const body = await readJson(req);
  const reason = String(body.reason ?? new URL(req.url).searchParams.get("reason") ?? "");
  return json(await execute<Freeze>(db, { kind: "unfreeze", actor_id: id, user_id: user.id, reason }));
});
