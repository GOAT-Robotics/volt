import "server-only";
import { db } from "./db";
import { HttpError } from "./session";
import { customRoleToken, isCustomRole, parseRoles, type Action } from "./roles";
import { CUSTOM_ALLOWED } from "./roles";

/**
 * External partners: users outside the organization who sign in with an emailed link and work only
 * on the projects they are assigned to. Their workspace membership (source EXTERNAL) holds exactly
 * one custom role; project membership is the scope.
 */
export type ExternalUser = {
  userId: string;
  name: string;
  email: string;
  company: string;
  roleId: string | null;
  projectIds: string[];
  accessUntil: string | null;
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  pendingInvite: boolean;
};

export async function listExternal(workspaceId: string): Promise<ExternalUser[]> {
  const mems = await db.membership.findMany({
    where: { workspaceId, user: { external: true } },
    include: { user: { include: { projectMembers: { where: { project: { workspaceId } }, select: { projectId: true } }, loginTokens: { where: { usedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } } } } },
    orderBy: { user: { name: "asc" } },
  });
  return mems.map((m) => {
    const custom = parseRoles(m.roles).find(isCustomRole);
    return {
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      company: m.user.company,
      roleId: custom ? custom.slice(7) : null,
      projectIds: m.user.projectMembers.map((p) => p.projectId),
      accessUntil: m.user.accessUntil?.toISOString() ?? null,
      disabled: m.user.disabled,
      lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
      createdAt: m.user.createdAt.toISOString(),
      pendingInvite: m.user.loginTokens.length > 0,
    };
  });
}

export async function assertRole(workspaceId: string, roleId: string) {
  const r = await db.customRole.findFirst({ where: { id: roleId, workspaceId } });
  if (!r) throw new HttpError(400, "Pick a custom role of this workspace");
  return r;
}

/** sets the user's projects to exactly these (projects of this workspace only) */
export async function setProjects(workspaceId: string, userId: string, projectIds: string[]) {
  const valid = await db.project.findMany({ where: { workspaceId, id: { in: projectIds } }, select: { id: true, name: true } });
  if (valid.length !== new Set(projectIds).size) throw new HttpError(400, "Unknown project");
  const current = await db.projectMember.findMany({ where: { userId, project: { workspaceId } }, select: { projectId: true } });
  const want = new Set(valid.map((p) => p.id));
  const have = new Set(current.map((c) => c.projectId));
  const add = [...want].filter((id) => !have.has(id));
  const remove = [...have].filter((id) => !want.has(id));
  if (remove.length) await db.projectMember.deleteMany({ where: { userId, projectId: { in: remove } } });
  for (const projectId of add) await db.projectMember.create({ data: { projectId, userId, roles: "" } });
  return { added: add, removed: remove, names: valid.map((p) => p.name) };
}

export const roleTokenFor = (roleId: string) => customRoleToken(roleId);

/** keeps only the actions a custom role may grant */
export const cleanActions = (a: string[]): Action[] => [...new Set(a)].filter((x): x is Action => CUSTOM_ALLOWED.has(x as Action));
