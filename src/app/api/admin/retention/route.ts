import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";

export const runtime = "nodejs";

/** Run retention now: delete old autosaves and archive inactive projects. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const r = ctx.settings.retention;
  const b = await body(req, z.object({ autosaveDays: z.number().int().min(1).max(3650).optional(), archiveDays: z.number().int().min(1).max(36500).nullish(), dryRun: z.boolean().default(false) }));
  const autosaveDays = b.autosaveDays ?? r.deleteAutosavesAfterDays;
  const archiveDays = b.archiveDays === undefined ? r.archiveAfterDays : b.archiveDays;
  const now = Date.now();
  const autosaveWhere = { createdAt: { lt: new Date(now - autosaveDays * 86400_000) }, version: { project: { workspaceId: ctx.workspace.id } } };
  const archiveWhere = archiveDays ? { workspaceId: ctx.workspace.id, state: "ACTIVE", updatedAt: { lt: new Date(now - archiveDays * 86400_000) } } : null;
  if (b.dryRun) {
    return {
      autosaves: await db.autosave.count({ where: autosaveWhere }),
      projects: archiveWhere ? await db.project.count({ where: archiveWhere }) : 0,
      dryRun: true,
    };
  }
  const del = await db.autosave.deleteMany({ where: autosaveWhere });
  let archived: { id: string; name: string }[] = [];
  if (archiveWhere) {
    archived = await db.project.findMany({ where: archiveWhere, select: { id: true, name: true } });
    // keep updatedAt unchanged semantics: archiving itself is the activity
    await db.project.updateMany({ where: { id: { in: archived.map((p) => p.id) } }, data: { state: "ARCHIVED" } });
    for (const p of archived) await audit({ workspaceId: ctx.workspace.id, projectId: p.id, actorId: ctx.user.id, type: "project.archive", data: { state: "ARCHIVED", reason: `Inactive for ${archiveDays} days (retention)` } });
  }
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.retention", data: { autosavesDeleted: del.count, autosaveDays, projectsArchived: archived.length, archiveDays } });
  return { autosaves: del.count, projects: archived.length, dryRun: false };
});
