import { buildSnapshot } from "@/lib/db";
import { LIVE_STATE_CHANGED, liveEmitter } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/events — Server-Sent Events stream.
//
// This is the "no page refresh" backbone: every Operator Dashboard and TV
// Display tab holds one of these connections open. The moment any mutation
// (scan, next, sold, flash deal, product edit) happens anywhere, every
// connected tab receives a fresh snapshot and re-renders.
export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = async (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      const onChange = async () => {
        try {
          const snapshot = await buildSnapshot();
          await send("snapshot", snapshot);
        } catch {
          // swallow — a bad tick shouldn't kill the stream
        }
      };

      // Send an initial snapshot immediately so a freshly opened tab (TV,
      // new dashboard window) is in sync without waiting on the next event.
      await onChange();

      liveEmitter.on(LIVE_STATE_CHANGED, onChange);

      // Heartbeat comment keeps intermediary proxies from closing the
      // connection during quiet stretches between scans.
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 25000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        liveEmitter.off(LIVE_STATE_CHANGED, onChange);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
