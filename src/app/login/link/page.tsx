import type { Metadata } from "next";
import Link from "next/link";
import { signIn } from "@/auth";
import { peekToken } from "@/lib/magiclink";
import { AuthShell } from "@/components/brand/AuthLayout";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

const WHY: Record<string, string> = {
  invalid: "This sign-in link is not valid. Check that you opened the whole link from the email.",
  used: "This sign-in link has already been used. Each link works once.",
  expired: "This sign-in link has expired.",
  disabled: "This account has been disabled. Contact the person who invited you.",
  ended: "Your access to this workspace has ended. Contact the person who invited you.",
};

/**
 * Landing page of an emailed sign-in link. Opening it does not sign in (mail scanners open links):
 * the button does, and only then is the one-time token used.
 */
export default async function LinkSignIn({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? "";
  const c = await peekToken(token);
  return (
    <AuthShell>
      <h1 className="text-sm font-semibold">Sign in with your link</h1>
      {c.ok ? (
        <>
          <p className="mt-1 text-xs text-muted">
            Continue as <b className="text-fg">{c.user.name}</b> ({c.user.email}).
          </p>
          <form
            className="mt-5"
            action={async () => {
              "use server";
              await signIn("magic", { token, redirectTo: "/projects" });
            }}
          >
            <button className="h-9 w-full rounded-md bg-accent text-sm font-medium text-white">Sign in to Volt</button>
          </form>
          <p className="mt-3 text-2xs text-subtle">The link works once. Not you? Close this page.</p>
        </>
      ) : (
        <>
          <p className="mt-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-xs text-danger">{WHY[c.reason]}</p>
          {(c.reason === "used" || c.reason === "expired") && (
            <p className="mt-3 text-xs text-muted">
              <Link href="/login#email-link" className="text-accent hover:underline">
                Get a new sign-in link
              </Link>
            </p>
          )}
        </>
      )}
    </AuthShell>
  );
}
