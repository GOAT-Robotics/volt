import { redirect } from "next/navigation";
import { signIn, DEV_LOGIN, ENTRA_ENABLED } from "@/auth";
import { getCtx } from "@/lib/session";

const ERRORS: Record<string, string> = {
  AccessDisabled: "Your access has been disabled. Contact your workspace administrator.",
  GuestsNotAllowed: "Guest accounts are not allowed in this workspace.",
  NoWorkspaceAccess: "You don’t have access to this workspace yet. Ask an administrator to add you or your Entra group.",
  NoEmail: "Your account has no email address.",
  AccessDenied: "Access denied.",
  Configuration: "Sign-in is not configured correctly.",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; callbackUrl?: string; reauth?: string }> }) {
  const sp = await searchParams;
  // Only skip the login page for a session whose user still exists and has access. A stale cookie
  // (e.g. after the database was reset) must not bounce between /login and the app forever.
  const ctx = sp.error || sp.reauth ? null : await getCtx();
  if (ctx) redirect(safeCallback(sp.callbackUrl));
  const reauth = !!sp.reauth;
  const cb = safeCallback(sp.callbackUrl);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent shadow-float">
            <svg viewBox="0 0 32 32" className="size-6">
              <path d="M18 5 9 18h6l-2 9 9-13h-6z" fill="#fff" />
            </svg>
          </div>
          <div>
            <p className="text-base font-semibold">Volt</p>
            <p className="text-2xs text-muted">Electrical diagrams & document control</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-panel p-6 shadow-float">
          <h1 className="text-sm font-semibold">Sign in</h1>
          <p className="mt-1 text-xs text-muted">Use your organization account.</p>
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
        </div>
        <p className="mt-4 text-center text-2xs text-subtle">Compatible with QElectroTech .qet projects and .elmt elements.</p>
      </div>
    </main>
  );
}

/** Only same-origin relative paths are allowed as post-login destinations. */
function safeCallback(u?: string) {
  return u && u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/login") ? u : "/projects";
}
