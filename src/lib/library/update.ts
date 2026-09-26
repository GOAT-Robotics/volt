import "server-only";
import { z } from "zod";
import { HttpError, type Ctx } from "@/lib/session";
import { db, J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { APPROVED_REV_KEY, REJECT_KEY, approverIds, isApprover, tagsIn, writableLibrary, type Access } from "./access";
import { checkElmt } from "./store";
import { normCategory } from "./elmt-tools";
import type { BlockContent } from "@/core/model";

export const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().max(400).optional(),
  prefix: z.string().max(16).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.string()).optional(),
  license: z.string().max(400).nullable().optional(),
  attribution: z.string().max(1000).nullable().optional(),
  source: z.string().max(1000).nullable().optional(),
  libraryId: z.string().optional(),
  content: z.string().min(2).max(5_000_000).optional(),
  note: z.string().max(500).optional(),
  baseRevision: z.number().int().optional(),
});

/** Shared by PATCH/PUT and PUT /api/library/blocks/{id}. */
export async function updateElement(ctx: Ctx, a: Access, b: z.infer<typeof Patch>) {
  const el = a.el;
  if (!a.canEdit) throw new HttpError(403, "You cannot edit this element");
  if (b.baseRevision !== undefined && b.baseRevision !== el.revision) throw new HttpError(409, `This element was changed by someone else (now revision ${el.revision}). Reload to get the latest version.`, "CONFLICT");
  const data: Record<string, unknown> = {};
  if (b.name !== undefined) data.name = b.name;
  if (b.category !== undefined) data.category = normCategory(b.category);
  if (b.prefix !== undefined) data.prefix = b.prefix.trim();
  if (b.description !== undefined) data.description = b.description;
  if (b.tags !== undefined) data.tags = JSON.stringify(tagsIn(b.tags));
  if (b.license !== undefined) data.license = b.license || null;
  if (b.attribution !== undefined) data.attribution = b.attribution || null;
  if (b.source !== undefined) data.source = b.source || null;
  const rawMeta = J.parse<Record<string, unknown>>(el.meta, {});
  if (b.meta !== undefined) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawMeta)) if (k.startsWith("__")) next[k] = v;
    for (const [k, v] of Object.entries(b.meta)) if (!k.startsWith("__") && v.trim()) next[k] = v.trim();
    data.meta = JSON.stringify(next);
  }
  if (b.libraryId && b.libraryId !== el.libraryId) {
    if (!a.canManage) throw new HttpError(403, "Only the owner can move this element to another library");
    await writableLibrary(ctx, b.libraryId);
    data.libraryId = b.libraryId;
  }
  let revision = el.revision;
  let status = el.status;
  const contentChanged = b.content !== undefined && b.content !== el.content;
  if (contentChanged) {
    if (el.kind === "BLOCK") {
      try {
        const c = JSON.parse(b.content!) as BlockContent;
        if (!c || !Array.isArray(c.elements) || typeof c.defs !== "object") throw new Error("bad");
      } catch {
        throw new HttpError(400, "Invalid block content");
      }
    } else {
      let def;
      try {
        def = checkElmt(b.content!, el.name);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (def.uuid && def.uuid !== el.uuid) {
        const clash = await db.libraryElement.findFirst({ where: { uuid: def.uuid, id: { not: el.id }, library: { workspaceId: ctx.workspace.id } }, select: { id: true } });
        if (clash) throw new HttpError(409, "Another library element already uses this element uuid");
        data.uuid = def.uuid;
      }
    }
    // workflow on content change of an organisation element
    const meta = J.parse<Record<string, unknown>>((data.meta as string) ?? el.meta, {});
    delete meta[REJECT_KEY];
    let notifyApprovers = false;
    if (el.visibility === "ORG" && (el.status === "APPROVED" || el.status === "PUBLISHED")) {
      if (ctx.settings.library.requireApprovalForOrg && !isApprover(ctx)) {
        status = "PENDING_APPROVAL";
        notifyApprovers = true;
      } else if (el.status === "APPROVED") {
        meta[APPROVED_REV_KEY] = el.revision + 1;
        data.approvedById = ctx.user.id;
        data.approvedAt = new Date();
      }
    }
    data.meta = JSON.stringify(meta);
    data.status = status;
    revision = el.revision + 1;
    const content = b.content!;
    await db.$transaction([
      db.libraryElement.update({ where: { id: el.id }, data: { ...data, content, revision } }),
      db.libraryElementRevision.create({ data: { elementId: el.id, revision, content, meta: data.meta as string, note: (b.note?.trim() || "Updated").slice(0, 500), userId: ctx.user.id } }),
    ]);
    if (notifyApprovers) {
      await notify((await approverIds(ctx.workspace.id)).filter((u) => u !== ctx.user.id), {
        type: "library.approval",
        title: `Re-approval requested: ${el.name}`,
        body: `${ctx.user.name} changed “${el.name}” (now rev ${revision}). Organization users keep using the approved revision until you approve.`,
        link: `/library/${el.id}`,
        workspaceId: ctx.workspace.id,
      });
    }
  } else if (Object.keys(data).length) {
    await db.libraryElement.update({ where: { id: el.id }, data });
  }
  await audit({
    workspaceId: ctx.workspace.id,
    actorId: ctx.user.id,
    type: "library.update",
    data: { id: el.id, name: (data.name as string) ?? el.name, fields: Object.keys(data).filter((k) => k !== "meta" || b.meta !== undefined), revision, contentChanged, note: b.note ?? null },
  });
  return { id: el.id, revision, status };
}

