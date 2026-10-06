import "server-only";
import { requireIntegration } from "./auth";
import { ApiError } from "./gateway";

/** Endpoint calls authenticate with the owning integration's key plus a stable endpoint id. */
export async function requireEndpoint(req: Request, bodyId?: unknown) {
  const { db, integration } = await requireIntegration(req);
  const url = new URL(req.url);
  const raw = (typeof bodyId === "string" ? bodyId : undefined) ?? req.headers.get("x-orbis-endpoint") ?? url.searchParams.get("endpoint_id") ?? "";
  const endpointId = raw.trim();
  if (!/^[A-Za-z0-9._:-]{3,80}$/.test(endpointId)) throw new ApiError(422, "invalid_endpoint_id", "Send X-Orbis-Endpoint: <stable id, 3-80 chars [A-Za-z0-9._:-]>.");
  return { db, integration, endpointId };
}
