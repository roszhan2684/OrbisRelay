import { requireEndpoint } from "@/lib/server/endpoint-auth";
import { handle, json, readJson } from "@/lib/server/http";
import { execute } from "@/lib/server/ops";

type Ctx = { params: Promise<{ name: string; version: string }> };

/** POST /v1/endpoint/models/{name}/{version}/activation-result — {activated, error?, compile_ms?}. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { version } = await ctx.params;
  const body = await readJson<{ activated?: boolean; error?: string; compile_ms?: number; endpoint_id?: string }>(req);
  const { db, integration, endpointId } = await requireEndpoint(req, body.endpoint_id);
  return json(await execute(db, { kind: "endpoint_activation", integration_id: integration.id, endpoint_id: endpointId, version: version.slice(0, 20), activated: body.activated === true, error: typeof body.error === "string" ? body.error : undefined, compile_ms: typeof body.compile_ms === "number" ? body.compile_ms : undefined }));
});
