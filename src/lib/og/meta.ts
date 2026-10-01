import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { SITE_DESCRIPTION, SITE_NAME, type Preview } from "./preview";

import { orgBranding } from "@/lib/brand";

/** absolute origin for metadata (APP_URL / AUTH_URL, else the request host) */
export async function siteOrigin(): Promise<URL> {
  const env = process.env.APP_URL ?? process.env.AUTH_URL;
  if (env) {
    try {
      return new URL(env.replace(/\/$/, ""));
    } catch {}
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return new URL(`${proto}://${host}`);
}

/** Open Graph + Twitter tags for one project / library item */
export function previewMetadata(p: Preview, extra: Metadata = {}): Metadata {
  const image = { url: p.image, width: 1200, height: 630, alt: p.imageAlt, type: "image/png" };
  return {
    title: p.title,
    description: p.description,
    alternates: { canonical: p.path },
    openGraph: { type: "website", siteName: SITE_NAME, title: p.title, description: p.description, url: p.path, images: [image], locale: "en_US" },
    twitter: { card: "summary_large_image", title: p.title, description: p.description, images: [image] },
    ...extra,
  };
}

/** site-wide defaults (root layout) */
export async function siteMetadata(): Promise<Metadata> {
  const b = await orgBranding();
  const org = b.name.trim();
  const image = { url: "/og", width: 1200, height: 630, alt: `Volt — electrical diagrams & document control${org ? ` · ${org}` : ""}`, type: "image/png" };
  return {
    metadataBase: await siteOrigin(),
    title: { default: `${SITE_NAME} — Electrical diagrams & document control`, template: `%s · ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    generator: undefined,
    ...(org ? { authors: [{ name: org, ...(b.url ? { url: b.url } : {}) }], creator: org, publisher: org } : {}),
    keywords: ["electrical schematics", "electrical diagram editor", "QElectroTech", "wiring diagram", "control panel design", "IEC 60204-1", "IEC 61082", "document control", "engineering change", "Volt"],
    category: "engineering",
    referrer: "strict-origin-when-cross-origin",
    formatDetection: { telephone: false, email: false, address: false },
    // a private workspace: nothing but the sign-in page belongs in search engines
    robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
    openGraph: { type: "website", siteName: SITE_NAME, title: `${SITE_NAME} — Electrical diagrams & document control`, description: SITE_DESCRIPTION, images: [image], locale: "en_US" },
    twitter: { card: "summary_large_image", title: `${SITE_NAME} — Electrical diagrams & document control`, description: SITE_DESCRIPTION, images: [image] },
    appleWebApp: { title: SITE_NAME, capable: true, statusBarStyle: "default" },
    ...(org ? { other: { copyright: `© ${new Date().getFullYear()} ${org}` } } : {}),
  };
}
