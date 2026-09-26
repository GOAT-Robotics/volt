import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/brand/AuthLayout";
import { getCtx } from "@/lib/session";
import { signOutAction } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Sign out" };

export default async function Logout() {
  const ctx = await getCtx();
  return (
    <AuthShell>
      {ctx ? (
        <>
          <h1 className="text-sm font-semibold">Sign out</h1>
          <p className="mt-1 text-xs text-muted">
            You’re signed in as <span className="font-medium text-fg">{ctx.user.name}</span> ({ctx.user.email}).
          </p>
          <form action={signOutAction} className="mt-5 flex gap-2">
            <Link href="/projects" className="flex h-9 flex-1 items-center justify-center rounded-md border border-border bg-panel text-sm font-medium hover:bg-hover">
              Cancel
            </Link>
            <button className="h-9 flex-1 rounded-md bg-accent text-sm font-medium text-white hover:brightness-110">Sign out</button>
          </form>
        </>
      ) : (
        <>
          <h1 className="text-sm font-semibold">You’re signed out</h1>
          <p className="mt-1 text-xs text-muted">Sign in again to continue working.</p>
          <Link href="/login" className="mt-5 flex h-9 items-center justify-center rounded-md bg-accent text-sm font-medium text-white hover:brightness-110">
            Sign in
          </Link>
        </>
      )}
    </AuthShell>
  );
}
