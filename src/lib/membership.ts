import { db, ensurePragmas } from "./db";
import { parseSettings } from "./settings";
import { joinRoles, parseRoles, type Role } from "./roles";

export const DEFAULT_WORKSPACE_SLUG = process.env.WORKSPACE_SLUG ?? "default";

let wsExists = false;
/** The default workspace (created on first use). Only looked up until it is known to exist. */
export async function ensureDefaultWorkspace(): Promise<void> {
  if (wsExists) return;
  await ensurePragmas();
  await defaultWorkspace();
  wsExists = true;
}

export async function defaultWorkspace() {
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
/** Entra tenant the app trusts: AUTH_MICROSOFT_ENTRA_ID_TENANT or the GUID in the issuer URL */
export function entraTenant(): string | null {
  const t = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT?.trim();
  if (t) return t.toLowerCase();
  const m = /login\.microsoftonline\.com\/([0-9a-f-]{36})\//i.exec(process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER ?? "");
  return m ? m[1].toLowerCase() : null;
}

export async function syncUserOnSignIn(i: { email: string; name: string; oid: string | null; tid?: string | null; groups: string[]; isGuest: boolean }): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  if (!i.email) return { ok: false, reason: "NoEmail" };
  // Entra sign-ins must come from our own tenant (a multi-tenant issuer would accept any tenant)
  if (i.oid) {
    const tenant = entraTenant();
    if (!tenant || (i.tid ?? "").toLowerCase() !== tenant) return { ok: false, reason: "WrongTenant" };
  }
  const ws = await defaultWorkspace();
  const settings = parseSettings(ws.settings);
  // Identity is the Entra object id. An email only links to an account that has no Entra id yet
  // (invited or pre-created); the (mutable) email claim never takes over a bound account.
  let existing = i.oid ? await db.user.findUnique({ where: { entraOid: i.oid } }) : null;
  if (!existing) {
    const byEmail = await db.user.findUnique({ where: { email: i.email } });
    if (byEmail?.entraOid && i.oid && byEmail.entraOid !== i.oid) return { ok: false, reason: "AccountConflict" };
    if (byEmail?.entraOid && !i.oid) return { ok: false, reason: "AccountConflict" };
    existing = byEmail;
  }
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
    if (w.id === ws.id && !i.isGuest && adminEmails().includes(i.email)) roles.add("ADMIN");
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
    } else if (mem && mem.source !== "DOMAIN") {
      await db.membership.delete({ where: { id: mem.id } });
    }
  }

  // Bootstrap: without ADMIN_EMAILS, the first member (not a guest) becomes admin of the default workspace.
  const count = await db.membership.count({ where: { workspaceId: ws.id } });
  if (count === 0 && !adminEmails().length && !i.isGuest) {
    await db.membership.create({ data: { workspaceId: ws.id, userId: user.id, roles: "ADMIN", source: "MANUAL" } });
  } else {
    const domainOk = allowedDomains().length > 0 && allowedDomains().includes(i.email.split("@")[1] ?? "");
    const has = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } } });
    if (!has && domainOk && !i.isGuest) {
      // signs in, but sees only what an admin gives them (Admin → General → Access)
      const role = settings.access.newMemberRole;
      await db.membership.create({ data: { workspaceId: ws.id, userId: user.id, roles: role === "none" ? "" : role, source: "DOMAIN" } });
    }
  }
  const any = await db.membership.count({ where: { userId: user.id } });
  const guestInvites = await db.projectMember.count({ where: { userId: user.id } });
  if (!any && !guestInvites) return { ok: false, reason: "NoWorkspaceAccess" };
  return { ok: true, userId: user.id };
}
