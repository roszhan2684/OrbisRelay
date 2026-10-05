import { analyzeText, analyzeUrl } from "@/lib/ml/analyzer";
import { APPROVED_DESTINATIONS } from "@orbis/policy-core";

// Public, stateless "Is this safe?" for the marketing site. Nothing is stored. Naive per-IP rate limit.
const hits = new Map<string, { n: number; reset: number }>();

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const h = hits.get(ip);
  if (h && h.reset > now && h.n >= 30) return Response.json({ error: { code: "rate_limited", message: "Too many checks — try again in a minute." } }, { status: 429 });
  hits.set(ip, h && h.reset > now ? { n: h.n + 1, reset: h.reset } : { n: 1, reset: now + 60_000 });
  const body = (await req.json().catch(() => ({}))) as { kind?: string; input?: string };
  const input = String(body.input ?? "").slice(0, 2000).trim();
  if (!input) return Response.json({ error: { code: "validation_error", message: "Paste a link or message." } }, { status: 422 });
  const url = body.kind === "url" || body.kind === "qr";
  const r = url ? analyzeUrl(input, APPROVED_DESTINATIONS) : analyzeText(input, APPROVED_DESTINATIONS);
  return Response.json({ id: `pa_public_${now.toString(36)}`, kind: body.kind, input_preview: input.slice(0, 160), created_at: new Date().toISOString(), channel: "web", user_id: "public", tenant_id: "public", ...r });
}
