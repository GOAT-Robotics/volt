import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, assertCan, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

async function load(workspaceId: string, id: string) {
  const f = await db.folder.findFirst({ where: { id, workspaceId } });
  if (!f) throw new HttpError(404, "Folder not found");
  return f;
}

const Patch = z.object({ name: z.string().trim().min(1).max(120).optional(), parentId: z.string().nullish() });

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertCan(ctx, "project.create");
  const { id } = await params;
  const b = await body(req, Patch);
  const f = await load(ctx.workspace.id, id);
  if (b.parentId) {
    // prevent cycles
    let cur: string | null = b.parentId;
    while (cur) {
      if (cur === id) throw new HttpError(400, "A folder cannot be moved into itself");
      const p: { parentId: string | null } | null = await db.folder.findFirst({ where: { id: cur, workspaceId: ctx.workspace.id }, select: { parentId: true } });
      if (!p) throw new HttpError(400, "Parent folder not found");
      cur = p.parentId;
    }
  }
  await db.folder.update({ where: { id }, data: { ...(b.name !== undefined && { name: b.name }), ...(b.parentId !== undefined && { parentId: b.parentId || null }) } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "project.folder", data: { action: "update", from: f.name, name: b.name } });
  return { ok: true };
});

/** Deletes an empty folder (projects and sub-folders move to the parent). */
export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertCan(ctx, "project.manage");
  const { id } = await params;
  const f = await load(ctx.workspace.id, id);
  await db.$transaction([
    db.project.updateMany({ where: { folderId: id }, data: { folderId: f.parentId } }),
    db.folder.updateMany({ where: { parentId: id }, data: { parentId: f.parentId } }),
    db.folder.delete({ where: { id } }),
  ]);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "project.folder", data: { action: "delete", name: f.name } });
  return { ok: true };
});
