import { OrbisError } from "@orbis/sdk";
import { client, SCENARIOS, type ScenarioKey } from "../shared";

/** Demo customer backend: the agent proposes its next tool call and asks Orbis first. */
export async function POST(req: Request) {
  const { scenario } = (await req.json()) as { scenario: ScenarioKey };
  const sc = SCENARIOS[scenario];
  if (!sc) return Response.json({ error: "unknown scenario" }, { status: 400 });
  const id = `req_demo_${scenario}_${Date.now().toString(36)}`;
  try {
    const d = await client(req, sc.integration).preflight(sc.build(id));
    return Response.json({ decision: JSON.parse(JSON.stringify(d)) });
  } catch (e) {
    const err = e as OrbisError;
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status || 500 });
  }
}
