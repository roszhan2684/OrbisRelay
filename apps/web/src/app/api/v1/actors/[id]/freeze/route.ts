import { requireUser } from "@/lib/server/auth";
import { freezeActor, unfreezeActor } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST /v1/actors/{id}/freeze — emergency stop; the gateway denies all new requests immediately. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user, channel } = await requireUser(req);
  const body = await readJson(req);
  const fr = freezeActor(db, id, user, String(body.reason ?? "Emergency freeze"), channel === "ios" ? "ios" : "web");
  return json(fr, { status: 201 });
});

/** DELETE /v1/actors/{id}/freeze — restore with permission and an audit reason. */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { db, user } = await requireUser(req);
  const body = await readJson(req);
  const reason = String(body.reason ?? new URL(req.url).searchParams.get("reason") ?? "");
  return json(unfreezeActor(db, id, user, reason));
});
