import { NextRequest } from "next/server";

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

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function proxy(req: NextRequest, context: RouteContext) {
  if (!API_KEY) {
    return Response.json({ error: "API proxy is missing API_KEY" }, { status: 500 });
  }

  const { path } = await context.params;
  const upstream = new URL(path.join("/"), API_URL.endsWith("/") ? API_URL : `${API_URL}/`);
  upstream.search = req.nextUrl.search;

  const headers = new Headers(req.headers);
  headers.set("X-Api-Key", API_KEY);
  headers.delete("host");

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  const res = await fetch(upstream, {
    method: req.method,
    headers,
    body,
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

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
