import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@prisma/client", "nodemailer", "@resvg/resvg-js"],
  // server actions only carry small forms (sign-in/out, signing); uploads go through route handlers
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      // link preview images are fetched by chat apps and mail clients from other sites
      { source: "/((?!og(?:/|$)).*)", headers: [{ key: "Cross-Origin-Resource-Policy", value: "same-origin" }] },
      { source: "/og/:path*", headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }] },
      { source: "/og", headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }] },
    ];
  },
};

export default nextConfig;
