import { createHash } from "node:crypto";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { assertMember, loadElement } from "@/lib/library/access";
import { blockSvg, elmtSvg, errorSvg } from "@/lib/library/preview";
import type { BlockContent } from "@/core/model";

export const runtime = "nodejs";

const svgResponse = (svg: string, headers: Record<string, string>, status = 200) =>
  new Response(status === 304 ? null : svg, { status, headers: { "content-type": "image/svg+xml; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", ...headers } });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await apiCtx();
    assertMember(ctx);
    const { id } = await params;
    const a = await loadElement(ctx, id);
    const sp = new URL(req.url).searchParams;
    const revParam = sp.get("rev");
    const label = (sp.get("label") ?? "").slice(0, 20);
    const pins = sp.get("pins") === "1";
    const want = revParam ? Number(revParam) : a.viewerRevision;
    if (!Number.isInteger(want) || want < 1) throw new HttpError(400, "Invalid revision");
    if (!a.full && want > a.viewerRevision) throw new HttpError(404, "Revision not available");
    const etag = `"${createHash("sha1").update(`${id}|${want}|${label}|${pins}|v4`).digest("hex").slice(0, 20)}"`;
    const cache = revParam ? "private, max-age=31536000, immutable" : "private, no-cache";
    if (req.headers.get("if-none-match") === etag) return svgResponse("", { etag, "cache-control": cache }, 304);
    let content = a.el.content;
    if (want !== a.el.revision) {
      const r = await db.libraryElementRevision.findUnique({ where: { elementId_revision: { elementId: id, revision: want } } });
      if (!r) throw new HttpError(404, "Revision not found");
      content = r.content;
    }
    let svg: string;
    try {
      svg = a.el.kind === "BLOCK" ? blockSvg(JSON.parse(content) as BlockContent, a.el.name) : elmtSvg(content, { label, pinNumbers: pins });
    } catch (e) {
      console.error("[preview]", id, e);
      svg = errorSvg("Invalid symbol");
    }
    return svgResponse(svg, { etag, "cache-control": cache });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("[preview]", e);
    return svgResponse(errorSvg(status === 404 ? "Not found" : status === 401 ? "Sign in" : "Error"), { "cache-control": "no-store" }, status);
  }
}
