import { route } from "@/lib/api";
import { apiCtx, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { isGuestCtx } from "@/lib/access";
import { parseRoles, rolesAllow, type Action, type Role } from "@/lib/roles";

export const runtime = "nodejs";

/** User search for mentions, reviewer pickers and member management. role=review|approve|sign filters by capability. */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const role = url.searchParams.get("role");
  const projectId = url.searchParams.get("projectId");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 50);
  const text = q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {};
  let scope;
  if (projectId) {
    await loadProject(ctx, projectId);
    scope = { projectMembers: { some: { projectId } } };
  } else if (isGuestCtx(ctx)) {
    const mine = await db.projectMember.findMany({ where: { userId: ctx.user.id }, select: { projectId: true } });
    scope = { projectMembers: { some: { projectId: { in: mine.map((m) => m.projectId) } } } };
  } else {
    scope = { memberships: { some: { workspaceId: ctx.workspace.id } } };
  }
  const users = await db.user.findMany({
    where: { disabled: false, AND: [text, scope] },
    include: { memberships: { where: { workspaceId: ctx.workspace.id } } },
    orderBy: { name: "asc" },
    take: 200,
  });
  const need: Action | null = role === "review" ? "review.decide" : role === "approve" ? "review.approve" : role === "sign" ? "sign" : null;
  const out = users
    .filter((u) => {
      if (!need) return true;
      const roles: Role[] = u.memberships.length ? u.memberships.flatMap((m) => parseRoles(m.roles)) : u.isGuest ? ["GUEST"] : [];
      if (need === "sign") return roles.includes("SIGNATORY") || roles.includes("ADMIN");
      return rolesAllow(roles, need);
    })
    .slice(0, limit)
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      roles: u.memberships.length ? [...new Set(u.memberships.flatMap((m) => parseRoles(m.roles)))] : u.isGuest ? ["GUEST"] : [],
    }));
  return { users: out };
});
