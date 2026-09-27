import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/og/meta";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  return [{ url: new URL("/login", origin).toString(), changeFrequency: "monthly", priority: 1 }];
}
