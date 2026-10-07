import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { libraryPreview, projectPreview, SITE_DESCRIPTION } from "@/lib/og/preview";
import { previewMetadata } from "@/lib/og/meta";
import { orgBranding } from "@/lib/brand";
import { signIn, DEV_LOGIN, ENTRA_ENABLED } from "@/auth";
import { getCtx } from "@/lib/session";
import { AuthShell } from "@/components/brand/AuthLayout";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { mailConfigured } from "@/lib/mail";
import { createLoginLink, LOGIN_TTL_MIN, mailLoginLink } from "@/lib/magiclink";

const ERRORS: Record<string, string> = {
  AccessDisabled: "Your access has been disabled. Contact your workspace administrator.",
  GuestsNotAllowed: "Guest accounts are not allowed in this workspace.",
  NoWorkspaceAccess: "You don’t have access to this workspace yet. Ask an administrator to add you or your Entra group.",
  NoEmail: "Your account has no email address.",
  AccessDenied: "Access denied.",
  Configuration: "Sign-in is not configured correctly.",
  ExternalUseLink: "This is an external partner account: sign in with the link from your invitation email, or get a new link below.",
  CredentialsSignin: "That sign-in link is not valid any more. Get a new one below.",
  RateLimited: "Too many sign-in link requests. Wait a few minutes and try again.",
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

const jsonLd = (org: { name: string; url: string }) => ({
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
  license: "https://www.gnu.org/licenses/gpl-3.0.html",
  ...(org.name ? { publisher: { "@type": "Organization", name: org.name, ...(org.url ? { url: org.url } : {}) } } : {}),
});

/** prefill of the development login: the first ADMIN_EMAILS address (the seeded admin) */
const DEV_EMAIL = (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0] ?? "admin@example.com";
const DEV_NAME = DEV_EMAIL.split("@")[0].split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; callbackUrl?: string; reauth?: string; signedOut?: string; sent?: string }> }) {
  const sp = await searchParams;
  // Only skip the login page for a session whose user still exists and has access. A stale cookie
  // (e.g. after the database was reset) must not bounce between /login and the app forever.
  const ctx = sp.error || sp.reauth ? null : await getCtx();
  if (ctx) redirect(safeCallback(sp.callbackUrl));
  const reauth = !!sp.reauth;
  const cb = safeCallback(sp.callbackUrl);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const org = await orgBranding();
  return (
    <AuthShell>
          <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(org)).replace(/</g, "\\u003c") }} />
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
          {sp.sent && !sp.error && (
            <p className="mt-4 rounded-md border border-success/20 bg-success-soft px-3 py-2 text-xs text-success">
              If {sp.sent} has access, a sign-in link is on its way. It works once, for {LOGIN_TTL_MIN} minutes.
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
              <input name="email" type="email" required placeholder="email" defaultValue={DEV_EMAIL} className="h-8 w-full rounded-md border border-border bg-panel px-2 text-xs" />
              <input name="name" placeholder="name" defaultValue={DEV_NAME} className="h-8 w-full rounded-md border border-border bg-panel px-2 text-xs" />
              <button className="h-8 w-full rounded-md bg-accent text-xs font-medium text-white">Sign in (dev)</button>
            </form>
          )}
          {mailConfigured() && (
            <form
              id="email-link"
              className="mt-5 space-y-2 border-t border-border pt-4"
              action={async (fd: FormData) => {
                "use server";
                await requestEmailLink(String(fd.get("email") ?? ""));
              }}
            >
              <p className="text-xs font-medium">External partner?</p>
              <p className="text-2xs text-muted">Get a one-time sign-in link by email. No password needed.</p>
              <input name="email" type="email" required placeholder="you@company.com" className="h-8 w-full rounded-md border border-border bg-panel px-2 text-xs" />
              <button className="h-8 w-full rounded-md border border-border bg-panel text-xs font-medium hover:bg-hover">Email me a sign-in link</button>
            </form>
          )}
    </AuthShell>
  );
}

/**
 * Sends a sign-in link to an external partner. Answers the same whether or not the address has
 * access (no account discovery); limited per address and per client.
 */
async function requestEmailLink(raw: string) {
  const email = raw.trim().toLowerCase().slice(0, 200);
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "?";
  try {
    rateLimit(`magic:ip:${ip}`, 10, 15 * 60_000);
    rateLimit(`magic:email:${email}`, 3, 15 * 60_000);
  } catch {
    redirect("/login?error=RateLimited");
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const user = await db.user.findUnique({ where: { email } });
    if (user?.external && !user.disabled && (!user.accessUntil || user.accessUntil.getTime() > Date.now())) {
      const proto = h.get("x-forwarded-proto") ?? "https";
      const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
      const link = await createLoginLink(user.id, "login", null, new Request(`${proto}://${host}/`));
      const ws = await db.membership.findFirst({ where: { userId: user.id }, include: { workspace: true } });
      await mailLoginLink(user, link.url, link.expiresAt, { workspace: ws?.workspace.name ?? "Volt" });
      await db.auditEvent.create({ data: { actorId: user.id, workspaceId: ws?.workspaceId, type: "auth.link.requested", data: "{}" } }).catch(() => {});
    }
  }
  redirect(`/login?sent=${encodeURIComponent(email)}`);
}

/** Only same-origin relative paths are allowed as post-login destinations. */
function safeCallback(u?: string) {
  // same-site paths only: "//host" and "/\\host" are protocol-relative in browsers
  return u && u.startsWith("/") && !/^\/[\/\\]/.test(u) && !/[\r\n\t\\]/.test(u) && !u.startsWith("/login") ? u : "/projects";
}
