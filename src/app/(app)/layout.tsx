import { requireCtx } from "@/lib/session";
import { AppShell } from "@/components/shell/AppShell";
import { db } from "@/lib/db";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const pendingReviews = await db.reviewAssignment.count({
    where: { decision: "PENDING", review: { status: "OPEN" }, OR: [{ userId: ctx.user.id }, { groupId: { in: ctx.user.groups.length ? ctx.user.groups : ["-"] } }] },
  });
  const pendingSigs = await db.signature.count({ where: { signatoryId: ctx.user.id, status: "REQUESTED" } });
  return (
    <AppShell
      inboxCount={pendingReviews + pendingSigs}
      user={{
        name: ctx.user.name,
        email: ctx.user.email,
        roles: ctx.roles,
        isAdmin: ctx.roles.includes("ADMIN"),
        workspace: ctx.workspace.name,
        workspaceId: ctx.workspace.id,
        workspaces: ctx.workspaces,
      }}
    >
      {children}
    </AppShell>
  );
}
