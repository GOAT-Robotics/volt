import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, assertCan, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOutsider } from "@/lib/access";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  if (isOutsider(ctx)) return { folders: [] };
  const rows = await db.folder.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { name: "asc" } });
  return { folders: rows.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })) };
});

const Body = z.object({ name: z.string().trim().min(1, "Name is required").max(120), parentId: z.string().nullish() });

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertCan(ctx, "project.create");
  const b = await body(req, Body);
  if (b.parentId && !(await db.folder.findFirst({ where: { id: b.parentId, workspaceId: ctx.workspace.id } }))) throw new HttpError(400, "Parent folder not found");
  const f = await db.folder.create({ data: { workspaceId: ctx.workspace.id, name: b.name, parentId: b.parentId ?? null } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "project.folder", data: { action: "create", name: b.name } });
  return { id: f.id };
});
