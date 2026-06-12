import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const API_URL = process.env["API_URL"] ?? process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
const API_KEY = process.env["API_KEY"];

type SignalItem = {
  id: string;
  observedAt: number;
};

type FillItem = {
  id: string;
  decidedAt: number;
};

function apiEndpoint(path: string) {
  return new URL(path, API_URL.endsWith("/") ? API_URL : `${API_URL}/`);
}

async function fetchJson<T>(path: string): Promise<T> {
  if (!API_KEY) throw new Error("API proxy is missing API_KEY");

  const res = await fetch(apiEndpoint(path), {
    headers: { "X-Api-Key": API_KEY },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API stream proxy upstream failed: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function GET(req: NextRequest) {
  if (!API_KEY) {
    return Response.json({ error: "API proxy is missing API_KEY" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let streamLastChecked = new Date();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (value: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const poll = async () => {
        const since = streamLastChecked;
        streamLastChecked = new Date();

        try {
          const sinceParam = encodeURIComponent(since.toISOString());
          const [{ signals }, { fills }] = await Promise.all([
            fetchJson<{ signals: SignalItem[] }>(`signals?since=${sinceParam}&limit=50`),
            fetchJson<{ fills: FillItem[] }>(`fills?since=${sinceParam}&limit=50`),
          ]);

          for (const signal of signals) {
            send({ type: "trade-signal", data: signal });
          }
          for (const fill of fills) {
            send({ type: "paper-fill", data: fill });
          }
          if (signals.length === 0 && fills.length === 0) {
            send({ type: "ping" });
          }
        } catch (err) {
          send({ type: "error", error: err instanceof Error ? err.message : "Stream proxy failed" });
        }
      };

      void poll();
      const timer = setInterval(() => void poll(), 2_000);
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
