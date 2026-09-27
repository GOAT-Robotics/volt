import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers for every request:
 * - pages get a per-request nonce-based Content-Security-Policy (Next applies the nonce to its
 *   own scripts; the theme script in the root layout reads it from x-nonce)
 * - state-changing API calls must come from this site (Origin / Sec-Fetch-Site check), on top of
 *   SameSite cookies, which do not stop sibling sub-domains
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  // no Origin (older clients, some same-origin navigations): fall back to Fetch Metadata
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/")) {
    // Auth.js has its own CSRF token for its POSTs (sign-in/out)
    if (!SAFE.has(req.method) && !pathname.startsWith("/api/auth/") && !sameOrigin(req)) {
      return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
    }
    return NextResponse.next();
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // React style={{…}} attributes need inline styles
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    // sign-in posts to Auth.js, which redirects to Microsoft
    "form-action 'self' https://login.microsoftonline.com",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
