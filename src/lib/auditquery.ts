import type { Prisma } from "@prisma/client";

/** Audit filter from query params: type (exact or prefix ending with "."), user, project, from, to (YYYY-MM-DD). */
export function auditWhere(workspaceId: string, sp: URLSearchParams): Prisma.AuditEventWhereInput {
  const w: Prisma.AuditEventWhereInput = { OR: [{ workspaceId }, { workspaceId: null, actor: { memberships: { some: { workspaceId } } } }] };
  const type = sp.get("type");
  if (type) w.type = type.endsWith(".") ? { startsWith: type } : type;
  if (sp.get("user")) w.actorId = sp.get("user")!;
  if (sp.get("project")) w.projectId = sp.get("project")!;
  const valid = (d: string | null) => (d && !Number.isNaN(new Date(d).getTime()) ? d : null);
  const from = valid(sp.get("from"));
  const to = valid(sp.get("to"));
  if (from || to) w.createdAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(new Date(to).getTime() + 86400_000 - 1) } : {}) };
  return w;
}
