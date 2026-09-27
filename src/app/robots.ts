import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/og/meta";

export const dynamic = "force-dynamic";

/** A private workspace: only the sign-in page is public. Link preview images stay fetchable. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: [{ userAgent: "*", allow: ["/login", "/og"], disallow: ["/"] }],
    sitemap: new URL("/sitemap.xml", origin).toString(),
    host: origin.origin,
  };
}
