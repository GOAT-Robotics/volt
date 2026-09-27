import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION } from "@/lib/og/preview";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Volt — Electrical diagrams & document control",
    short_name: "Volt",
    description: SITE_DESCRIPTION,
    start_url: "/projects",
    scope: "/",
    display: "standalone",
    background_color: "#f7f7f8",
    theme_color: "#2546eb",
    categories: ["productivity", "business", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
