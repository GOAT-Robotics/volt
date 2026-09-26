import { db, ensurePragmas } from "./db";
import { parseSettings } from "./settings";
import { joinRoles, parseRoles, type Role } from "./roles";

export const DEFAULT_WORKSPACE_SLUG = process.env.WORKSPACE_SLUG ?? "default";

export async function ensureDefaultWorkspace() {
  await ensurePragmas();
  const ws = await db.workspace.findUnique({ where: { slug: DEFAULT_WORKSPACE_SLUG } });
  if (ws) return ws;
  return db.workspace.create({ data: { slug: DEFAULT_WORKSPACE_SLUG, name: process.env.WORKSPACE_NAME ?? "Workspace", settings: "{}" } });
}

const adminEmails = () => (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const allowedDomains = () => (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Upserts the user, applies Entra group → role mappings and admin bootstrap.
 * Denies disabled users, disallowed guests and users without any workspace access.
 */
export async function syncUserOnSignIn(i: { email: string; name: string; oid: string | null; groups: string[]; isGuest: boolean }): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  if (!i.email) return { ok: false, reason: "NoEmail" };
  const ws = await ensureDefaultWorkspace();
  const settings = parseSettings(ws.settings);
  const existing = i.oid ? await db.user.findFirst({ where: { OR: [{ entraOid: i.oid }, { email: i.email }] } }) : await db.user.findUnique({ where: { email: i.email } });
  if (existing?.disabled) return { ok: false, reason: "AccessDisabled" };
  if (i.isGuest && settings.guestPolicy === "deny") return { ok: false, reason: "GuestsNotAllowed" };

  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data: { name: i.name, email: i.email, entraOid: i.oid ?? existing.entraOid, groups: JSON.stringify(i.groups), isGuest: i.isGuest, lastLoginAt: new Date() } })
    : await db.user.create({ data: { name: i.name, email: i.email, entraOid: i.oid, groups: JSON.stringify(i.groups), isGuest: i.isGuest, lastLoginAt: new Date() } });

  // group mappings (union of all matched mappings) — source GROUP memberships are recomputed each login
  const workspaces = await db.workspace.findMany({ include: { groupMappings: true } });
  for (const w of workspaces) {
    const roles = new Set<Role>();
    for (const m of w.groupMappings) if (i.groups.includes(m.entraGroupId)) parseRoles(m.roles).forEach((r) => roles.add(r));
    if (w.id === ws.id && adminEmails().includes(i.email)) roles.add("ADMIN");
    const mem = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: user.id } } });
    if (mem && mem.source === "MANUAL") {
      if (roles.size) {
        const merged = new Set([...parseRoles(mem.roles), ...roles]);
        await db.membership.update({ where: { id: mem.id }, data: { roles: joinRoles(merged) } });
      }
      continue;
    }
    if (roles.size) {
      if (i.isGuest && settings.guestPolicy === "reviewOnly") {
        roles.clear();
        roles.add("GUEST");
      }
      await db.membership.upsert({
        where: { workspaceId_userId: { workspaceId: w.id, userId: user.id } },
        update: { roles: joinRoles(roles), source: "GROUP" },
        create: { workspaceId: w.id, userId: user.id, roles: joinRoles(roles), source: "GROUP" },
      });
    } else if (mem) {
      await db.membership.delete({ where: { id: mem.id } });
    }
  }

  // Bootstrap: first ever user becomes admin of the default workspace.
  const count = await db.membership.count({ where: { workspaceId: ws.id } });
  if (count === 0) {
    await db.membership.create({ data: { workspaceId: ws.id, userId: user.id, roles: "ADMIN", source: "MANUAL" } });
  } else {
    const domainOk = allowedDomains().length > 0 && allowedDomains().includes(i.email.split("@")[1] ?? "");
    const has = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } } });
    if (!has && domainOk && !i.isGuest) {
      await db.membership.create({ data: { workspaceId: ws.id, userId: user.id, roles: process.env.DEFAULT_ROLE ?? "VIEWER", source: "MANUAL" } });
    }
  }
  const any = await db.membership.count({ where: { userId: user.id } });
  const guestInvites = await db.projectMember.count({ where: { userId: user.id } });
  if (!any && !guestInvites) return { ok: false, reason: "NoWorkspaceAccess" };
  return { ok: true, userId: user.id };
}
