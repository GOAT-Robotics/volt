import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertMember, canManageLibrary, isAdmin, isApprover } from "@/lib/library/access";

export const runtime = "nodejs";

async function load(id: string, wsId: string) {
  const lib = await db.library.findUnique({ where: { id } });
  if (!lib || lib.workspaceId !== wsId) throw new HttpError(404, "Library not found");
  return lib;
}

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  scope: z.enum(["PERSONAL", "SHARED", "ORG"]).optional(),
  source: z.string().max(1000).nullable().optional(),
  license: z.string().max(400).nullable().optional(),
  attribution: z.string().max(1000).nullable().optional(),
  /** copy license/attribution/source onto every element of the library */
  applyToElements: z.boolean().optional(),
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const lib = await load(id, ctx.workspace.id);
  if (!canManageLibrary(ctx, lib)) throw new HttpError(403, "You cannot change this library");
  const b = await body(req, Patch);
  if (b.scope === "ORG" && lib.scope !== "ORG" && !isAdmin(ctx) && !isApprover(ctx)) throw new HttpError(403, "Only administrators and library approvers can make a library organization-wide");
  const { applyToElements, ...data } = b;
  const upd = await db.library.update({ where: { id }, data });
  if (applyToElements) await db.libraryElement.updateMany({ where: { libraryId: id }, data: { license: upd.license, attribution: upd.attribution, ...(upd.source ? {} : {}) } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.lib.update", data: { id, name: upd.name, fields: Object.keys(data), applyToElements: !!applyToElements } });
  return { ok: true };
});

export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const lib = await load(id, ctx.workspace.id);
  if (!canManageLibrary(ctx, lib)) throw new HttpError(403, "You cannot delete this library");
  const count = await db.libraryElement.count({ where: { libraryId: id } });
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (count && !force) throw new HttpError(409, `The library still contains ${count} element(s). Move or delete them first, or confirm deleting everything.`, "NOT_EMPTY");
  await db.library.delete({ where: { id } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.lib.delete", data: { id, name: lib.name, elements: count } });
  return { ok: true };
});
