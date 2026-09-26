import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db, J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isAdmin } from "@/lib/access";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { project, can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  return { project: { id: project.id, name: project.name, number: project.number, description: project.description, tags: J.parse<string[]>(project.tags, []), folderId: project.folderId, state: project.state, versionScheme: project.versionScheme, customScheme: project.customScheme } };
});

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  number: z.string().trim().max(60).nullish(),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  folderId: z.string().nullish(),
  versionScheme: z.enum(["INTEGER", "DECIMAL", "LETTER", "CUSTOM"]).optional(),
  customScheme: z.string().trim().max(40).nullish(),
  state: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Patch);
  const { project, can } = await loadProject(ctx, id);
  if (!can("project.manage")) throw new HttpError(403, "Only project owners can change project settings");
  if (b.folderId && !(await db.folder.findFirst({ where: { id: b.folderId, workspaceId: project.workspaceId } }))) throw new HttpError(400, "Folder not found");
  if (b.number && b.number !== project.number && (await db.project.findFirst({ where: { workspaceId: project.workspaceId, number: b.number, id: { not: id } } }))) throw new HttpError(409, `Project number ${b.number} is already used`);
  if (b.versionScheme && (b.versionScheme !== project.versionScheme || (b.customScheme ?? null) !== project.customScheme)) {
    const released = await db.version.count({ where: { projectId: id, releasedAt: { not: null } } });
    if (released) throw new HttpError(409, "The version scheme cannot change after the first release");
    if (b.versionScheme === "CUSTOM" && !b.customScheme?.includes("{n}")) throw new HttpError(400, "Custom scheme must contain {n}");
  }
  const data = {
    ...(b.name !== undefined && { name: b.name }),
    ...(b.number !== undefined && { number: b.number || null }),
    ...(b.description !== undefined && { description: b.description }),
    ...(b.tags !== undefined && { tags: JSON.stringify([...new Set(b.tags)]) }),
    ...(b.folderId !== undefined && { folderId: b.folderId || null }),
    ...(b.versionScheme !== undefined && { versionScheme: b.versionScheme, customScheme: b.versionScheme === "CUSTOM" ? b.customScheme ?? null : null }),
    ...(b.state !== undefined && { state: b.state }),
  };
  await db.project.update({ where: { id }, data });
  const type = b.state && b.state !== project.state ? "project.archive" : "project.update";
  await audit({ workspaceId: project.workspaceId, projectId: id, actorId: ctx.user.id, type, data: { ...b, ...(b.state ? { state: b.state } : {}) } });
  return { ok: true };
});

/** Permanent deletion — workspace admins only; requires the project name as confirmation. */
export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { project } = await loadProject(ctx, id);
  if (!isAdmin(ctx) || project.workspaceId !== ctx.workspace.id) throw new HttpError(403, "Only workspace administrators can delete projects");
  const b = await body(req, z.object({ confirm: z.string() }));
  if (b.confirm.trim() !== project.name) throw new HttpError(400, "Type the project name to confirm deletion");
  const versions = await db.version.count({ where: { projectId: id } });
  await db.project.delete({ where: { id } });
  // project-scoped audit rows keep projectId as plain text; the deletion itself is recorded at workspace level
  await audit({ workspaceId: project.workspaceId, projectId: null, actorId: ctx.user.id, type: "project.delete", data: { projectId: id, name: project.name, number: project.number, versions } });
  return { ok: true };
});
