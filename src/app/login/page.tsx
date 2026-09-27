import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { libraryPreview, projectPreview, SITE_DESCRIPTION } from "@/lib/og/preview";
import { COMPANY, previewMetadata } from "@/lib/og/meta";
import { signIn, DEV_LOGIN, ENTRA_ENABLED } from "@/auth";
import { getCtx } from "@/lib/session";
import { AuthShell } from "@/components/brand/AuthLayout";

const ERRORS: Record<string, string> = {
  AccessDisabled: "Your access has been disabled. Contact your workspace administrator.",
  GuestsNotAllowed: "Guest accounts are not allowed in this workspace.",
  NoWorkspaceAccess: "You don’t have access to this workspace yet. Ask an administrator to add you or your Entra group.",
  NoEmail: "Your account has no email address.",
  AccessDenied: "Access denied.",
  Configuration: "Sign-in is not configured correctly.",
};

/**
 * A shared link (/projects/…, /library/…) lands here when the visitor is not signed in — including
 * the servers of Teams, Slack or Outlook that build link previews. They get the project's or
 * component's preview (as far as the organization allows, see lib/og/preview); people get the form.
 */
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }): Promise<Metadata> {
  const cb = safeCallback((await searchParams).callbackUrl);
  const proj = /^\/projects\/([a-z0-9]{10,40})(?:[/?#]|$)/i.exec(cb);
  const lib = /^\/library\/([a-z0-9]{10,40})(?:[/?#]|$)/i.exec(cb);
  const p = proj ? await projectPreview(proj[1]).catch(() => null) : lib ? await libraryPreview(lib[1]).catch(() => null) : null;
  if (p) return previewMetadata(p, { title: `${p.title} — sign in`, robots: { index: false, follow: false } });
  return {
    title: "Sign in",
    description: SITE_DESCRIPTION,
    alternates: { canonical: "/login" },
    robots: { index: true, follow: false },
  };
}

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Volt",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Electrical CAD",
  operatingSystem: "Web browser",
  description: SITE_DESCRIPTION,
  featureList: [
    "Electrical schematics editor compatible with QElectroTech (.qet, .elmt)",
    "Shared component and circuit block library",
    "Cross references, wire numbering and conductor data",
    "Cover sheets, title blocks and revision history",
    "Reviews, approvals and electronically signed releases",
    "PDF, SVG, PNG, DXF and QElectroTech export",
  ],
  publisher: {
    "@type": "Organization",
    name: COMPANY,
    url: "https://www.example.com",
    address: { "@type": "PostalAddress", addressLocality: "Springfield", addressRegion: "State", addressCountry: "IN" },
  },
};

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; callbackUrl?: string; reauth?: string; signedOut?: string }> }) {
  const sp = await searchParams;
  // Only skip the login page for a session whose user still exists and has access. A stale cookie
  // (e.g. after the database was reset) must not bounce between /login and the app forever.
  const ctx = sp.error || sp.reauth ? null : await getCtx();
  if (ctx) redirect(safeCallback(sp.callbackUrl));
  const reauth = !!sp.reauth;
  const cb = safeCallback(sp.callbackUrl);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <AuthShell>
          <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
          <h1 className="text-sm font-semibold">Sign in</h1>
          <p className="mt-1 text-xs text-muted">Use your organization account.</p>
          {sp.signedOut && !sp.error && !reauth && (
            <p className="mt-4 rounded-md border border-success/20 bg-success-soft px-3 py-2 text-xs text-success">You’ve been signed out.</p>
          )}
          {reauth && !sp.error && (
            <p className="mt-4 rounded-md border border-accent/20 bg-accent-soft px-3 py-2 text-xs text-accent">
              Signing a drawing requires a fresh sign-in. Please confirm your identity to continue.
            </p>
          )}
          {sp.error && <p className="mt-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-xs text-danger">{ERRORS[sp.error] ?? "Sign-in failed. Please try again."}</p>}
          {ENTRA_ENABLED ? (
            <form
              className="mt-5"
              action={async () => {
                "use server";
                await signIn("microsoft-entra-id", { redirectTo: cb }, reauth ? { prompt: "login" } : { prompt: "select_account" });
              }}
            >
              <button className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-panel text-sm font-medium hover:bg-hover">
                <svg viewBox="0 0 21 21" className="size-4">
                  <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                  <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                  <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                  <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                Continue with Microsoft
              </button>
            </form>
          ) : (
            !DEV_LOGIN && <p className="mt-4 text-xs text-warning">Microsoft Entra ID is not configured. Set AUTH_MICROSOFT_ENTRA_ID_* in the environment.</p>
          )}
          {DEV_LOGIN && (
            <form
              className="mt-5 space-y-2 border-t border-dashed border-border pt-4"
              action={async (fd: FormData) => {
                "use server";
                await signIn("dev", { email: fd.get("email"), name: fd.get("name"), redirectTo: cb });
              }}
            >
              <p className="text-2xs font-medium uppercase tracking-wide text-warning">Development login (disabled in production)</p>
              <input name="email" type="email" required placeholder="email" defaultValue="admin@example.com" className="h-8 w-full rounded-md border border-border bg-panel px-2 text-xs" />
              <input name="name" placeholder="name" defaultValue="Admin" className="h-8 w-full rounded-md border border-border bg-panel px-2 text-xs" />
              <button className="h-8 w-full rounded-md bg-accent text-xs font-medium text-white">Sign in (dev)</button>
            </form>
          )}
    </AuthShell>
  );
}

/** Only same-origin relative paths are allowed as post-login destinations. */
function safeCallback(u?: string) {
  // same-site paths only: "//host" and "/\\host" are protocol-relative in browsers
  return u && u.startsWith("/") && !/^\/[\/\\]/.test(u) && !/[\r\n\t\\]/.test(u) && !u.startsWith("/login") ? u : "/projects";
}
