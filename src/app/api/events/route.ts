import { buildSnapshot, getVersion } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cap how long a single serverless invocation holds this stream open. We
// close it ourselves a little before Vercel's own limit so the client gets
// a clean disconnect (and its built-in auto-reconnect) instead of a hard
// kill mid-frame.
export const maxDuration = 60;

// Tuned up from an earlier 1s interval, which (combined with tabs left
// open in the background for a long time) burned through a free-tier
// Redis request quota. The client also now closes this connection
// entirely while its tab is hidden (see LiveStateContext), which matters
// far more than this number for total request volume — this interval is
// just the steady-state "how fresh does live feel" knob.
const POLL_INTERVAL_MS = 2500;
const MAX_STREAM_MS = 50_000;

// GET /api/events — Server-Sent Events stream.
//
// This is the "no page refresh" backbone: every Operator Dashboard and TV
// Display tab holds one of these connections open. Because the app runs as
// stateless serverless functions, we poll a cheap Redis version counter
// (bumped by every mutating write, see src/lib/events.ts) and only pull a
// full snapshot when it actually changes.
export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      const ping = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      };

      let lastVersion: number | null = null;

      const tick = async () => {
        try {
          const version = await getVersion();
          if (version !== lastVersion) {
            lastVersion = version;
            const snapshot = await buildSnapshot();
            send("snapshot", snapshot);
          } else {
            ping();
          }
        } catch (err) {
          // A bad tick shouldn't kill the stream — but do surface it once
          // so a persistently broken backend (e.g. Redis down) is visible
          // in the client instead of just going silent forever.
          send("error", { message: err instanceof Error ? err.message : String(err) });
        }
      };

      // Send the current state immediately so a freshly opened tab (TV,
      // new dashboard window) is in sync without waiting on the first poll.
      await tick();

      const interval = setInterval(tick, POLL_INTERVAL_MS);
      const stopTimer = setTimeout(close, MAX_STREAM_MS);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        clearTimeout(stopTimer);
        close();
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
