export const dynamic = "force-dynamic";

const API_URL = process.env["API_URL"] ?? process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
const API_KEY = process.env["API_KEY"];

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

export async function GET() {
  if (!API_KEY) {
    return Response.json({ error: "API proxy is missing API_KEY" }, { status: 500 });
  }

  const upstream = new URL("metrics", API_URL.endsWith("/") ? API_URL : `${API_URL}/`);
  const res = await fetch(upstream, {
    headers: { "X-Api-Key": API_KEY },
    cache: "no-store",
  });

  const responseHeaders = new Headers(res.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header);
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
  });
}
