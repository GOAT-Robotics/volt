import { NextResponse } from "next/server";
import { readBody } from "@/lib/api";
import { HttpError } from "@/lib/session";
import { rateLimit } from "@/lib/ratelimit";
import { ctxFromBearer } from "@/lib/mcp/tokens";
import { handleMessage, PROTOCOL_VERSIONS } from "@/lib/mcp/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Volt MCP server (Model Context Protocol, Streamable HTTP, stateless JSON responses).
 * Authorization: Bearer <personal access token> — created under Connect AI. Cookies are never used
 * here, so a web page cannot make a signed-in browser call it. See docs/MCP.md.
 */
const MAX = 4 * 1024 * 1024;

function rpcError(status: number, message: string, id: unknown = null, headers: Record<string, string> = {}) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code: status === 401 ? -32001 : status === 403 ? -32003 : status === 429 ? -32029 : -32000, message } }, { status, headers });
}

/** this server's public address, for links in tool results (download links) */
function originOf(req: Request) {
  const configured = (process.env.APP_URL ?? process.env.AUTH_URL ?? "").replace(/\/$/, "");
  if (configured) return configured;
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "")}://${host}`;
}

export async function POST(req: Request) {
  let env;
  try {
    env = { ...(await ctxFromBearer(req)), origin: originOf(req), protocol: req.headers.get("mcp-protocol-version") ?? undefined };
  } catch (e) {
    const s = e instanceof HttpError ? e.status : 500;
    return rpcError(s, e instanceof HttpError ? e.message : "Internal error", null, s === 401 ? { "WWW-Authenticate": 'Bearer realm="volt", error="invalid_token"' } : {});
  }
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !PROTOCOL_VERSIONS.includes(pv)) return rpcError(400, `Unsupported MCP protocol version ${pv} (supported: ${PROTOCOL_VERSIONS.join(", ")})`);
  let raw: unknown;
  try {
    rateLimit(`mcp:${env.token.id}`, 300);
    raw = JSON.parse(new TextDecoder().decode(await readBody(req, MAX, "Request")));
  } catch (e) {
    if (e instanceof HttpError) return rpcError(e.status, e.message);
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body is not JSON" } }, { status: 400 });
  }
  const batch = Array.isArray(raw);
  const list = (batch ? raw : [raw]) as Parameters<typeof handleMessage>[0][];
  const out: object[] = [];
  for (const m of list) {
    try {
      const r = await handleMessage(m, env);
      if (r) out.push(r);
    } catch (e) {
      console.error("[mcp]", e);
      out.push({ jsonrpc: "2.0", id: (m as { id?: unknown })?.id ?? null, error: { code: -32603, message: e instanceof HttpError ? e.message : "Internal error" } });
    }
  }
  // only notifications / responses: accepted, nothing to say
  if (!out.length) return new Response(null, { status: 202 });
  return NextResponse.json(batch ? out : out[0], { headers: { "cache-control": "no-store" } });
}

/** no server-initiated stream (stateless server) */
export function GET() {
  return new Response(JSON.stringify({ error: "This MCP server answers POST requests only (Streamable HTTP, no SSE stream)" }), { status: 405, headers: { allow: "POST", "content-type": "application/json" } });
}

/** no sessions to end */
export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
