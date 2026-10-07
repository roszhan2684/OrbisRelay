import { requireUser } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { getDb, subscribe } from "@/lib/server/store";
import { syncConfigured } from "@/lib/server/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET /v1/stream — Server-Sent Events for live console and phone-twin updates. */
export async function GET(req: Request) {
  try {
    await requireUser(req);
  } catch (e) {
    return errorResponse(e);
  }
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      send({ type: "hello" });
      const unsub = subscribe(send);
      const ping = setInterval(() => send({ type: "ping" }), 20_000);
      // Serverless: replay ops written by other instances so this stream sees them too. Each replay
      // is a metered Blob list, and a tab can hold a stream open indefinitely, so keep this slow;
      // requests already pull on their own.
      const sync = syncConfigured() ? setInterval(() => void getDb().catch(() => {}), 10_000) : null;
      cleanup = () => {
        unsub();
        clearInterval(ping);
        if (sync) clearInterval(sync);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
