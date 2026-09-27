import "server-only";
import { HttpError } from "@/lib/session";
import { rateLimit } from "@/lib/ratelimit";
import { siteCardPng } from "./preview";

/**
 * PNG response for link preview images. Public (crawlers have no session); what they may show is
 * decided in ./preview. Anything not previewable gets the generic site card, so the answer does
 * not reveal whether an id exists.
 */
export async function ogResponse(req: Request, make: () => Promise<{ png: Buffer; etag: string } | null>): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  try {
    rateLimit(`og:${ip}`, 120);
  } catch (e) {
    if (e instanceof HttpError) return new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } });
    throw e;
  }
  let r: { png: Buffer; etag: string } | null = null;
  try {
    r = await make();
  } catch (e) {
    console.error("[og]", e);
  }
  const specific = !!r;
  r ??= await siteCardPng();
  const headers: Record<string, string> = {
    "content-type": "image/png",
    etag: r.etag,
    // crawlers and chat apps cache previews themselves; keep it short so a changed setting takes effect
    "cache-control": specific ? "public, max-age=600, stale-while-revalidate=3600" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
    "x-robots-tag": "noindex",
  };
  if (req.headers.get("if-none-match") === r.etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(r.png), { headers });
}
