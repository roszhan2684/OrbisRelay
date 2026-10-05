import { client, SCENARIOS, type ScenarioKey } from "../shared";

/**
 * The customer's own code executes the action (never the SDK), honoring server-approved parameters,
 * then reports the outcome so the receipt links decision → result.
 */
export async function POST(req: Request) {
  const { scenario, action_id, approved_parameters } = (await req.json()) as { scenario: ScenarioKey; action_id: string; approved_parameters?: Record<string, unknown> | null };
  const sc = SCENARIOS[scenario];
  const c = client(req, sc.integration);
  await new Promise((r) => setTimeout(r, 900)); // "do the work"
  const target = approved_parameters?.destination ?? null;
  const detail =
    scenario === "hero"
      ? target === "northstar-private-llm"
        ? "Summary generated on northstar-private-llm (zero retention)"
        : "Summary generated"
      : scenario === "refund"
        ? `Refunded $${Number(approved_parameters?.amount_usd ?? 8500).toLocaleString()}${approved_parameters?.method === "service_credit" ? " as service credit" : ""}`
        : scenario === "deploy"
          ? `Deployed billing-service v3.12.1${approved_parameters?.scheduled_for ? " (scheduled for next window)" : ""} · canary healthy`
          : "Config applied";
  const r = await c.reportOutcome(action_id, "succeeded", detail);
  return Response.json({ ok: true, detail, receipt_id: r.receipt_id });
}
