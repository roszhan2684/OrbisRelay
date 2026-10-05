import { client, SCENARIOS, type ScenarioKey } from "../shared";

/** Demo customer backend polls the approval exactly as the SDK's waitForResolution does. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sc = SCENARIOS[u.searchParams.get("scenario") as ScenarioKey];
  const id = u.searchParams.get("approval");
  if (!sc || !id) return Response.json({ error: "bad request" }, { status: 400 });
  return Response.json(await client(req, sc.integration).getApproval(id));
}
