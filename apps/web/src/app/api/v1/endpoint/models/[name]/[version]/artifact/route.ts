import { ApiError } from "@/lib/server/gateway";
import { requireEndpoint } from "@/lib/server/endpoint-auth";
import { handle } from "@/lib/server/http";
import { lifecycleAt, MODEL_NAME, registryEntry } from "@/lib/server/ml";

type Ctx = { params: Promise<{ name: string; version: string }> };

/**
 * GET /v1/endpoint/models/{name}/{version}/artifact — redirects to the zipped .mlpackage. Integrity comes
 * from the signed manifest's sha256, not from the transport; the endpoint refuses mismatches.
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { name, version } = await ctx.params;
  const { db } = await requireEndpoint(req);
  const entry = registryEntry(version);
  const dist = (entry?.artifacts as Record<string, unknown> | undefined)?.coreml_fp32_zip as { url: string } | undefined;
  if (name !== MODEL_NAME || !entry || !dist) throw new ApiError(404, "not_found", "Unknown model artifact.");
  const st = lifecycleAt(db, Date.now())[version]?.status;
  if (!st || !["shadow", "canary", "production", "deprecated"].includes(st)) throw new ApiError(403, "not_deployable", `Version ${version} is ${st ?? "unknown"} and not distributable.`);
  return Response.redirect(new URL(dist.url, req.url), 302);
});
