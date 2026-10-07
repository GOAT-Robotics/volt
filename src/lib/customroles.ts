import "server-only";
import { db } from "./db";
import { isCustomRole, ROLE_LABEL, setCustomRoleActions, type BuiltinRole, type Role } from "./roles";

/**
 * Custom roles live in the database; rolesAllow() reads them from an in-process registry that is
 * refreshed here (at most every few seconds, and immediately after an admin changes a role).
 */
let loadedAt = 0;
let names = new Map<string, string>();
const TTL = 5_000;

export async function loadCustomRoles(force = false) {
  if (!force && Date.now() - loadedAt < TTL) return;
  const rows = await db.customRole.findMany({ select: { id: true, name: true, actions: true } });
  setCustomRoleActions(rows);
  names = new Map(rows.map((r) => [r.id, r.name]));
  loadedAt = Date.now();
}

/** display name of a role ("Designer", "External designer") */
export function roleName(r: Role): string {
  return isCustomRole(r) ? names.get(r.slice(7)) ?? "Custom role (deleted)" : ROLE_LABEL[r as BuiltinRole] ?? r;
}
export const roleNames = (roles: Role[]) => roles.map(roleName);
