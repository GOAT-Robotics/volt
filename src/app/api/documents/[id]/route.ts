import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DOC_KINDS, docAccess } from "@/lib/documents";

export const runtime = "nodejs";

const Patch = z.object({ title: z.string().trim().min(1).max(200).optional(), kind: z.enum(DOC_KINDS).optional(), manufacturer: z.string().trim().max(200).optional(), partNumber: z.string().trim().max(200).optional() });

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Patch);
  const d = await db.partDocument.findUnique({ where: { id }, omit: { data: true } });
  if (!d) throw new HttpError(404, "Document not found");
  const a = await docAccess(ctx, d);
  if (!a.canEdit) throw new HttpError(403, "You cannot change this document");
  await db.partDocument.update({ where: { id }, data: b });
  return { ok: true };
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const d = await db.partDocument.findUnique({ where: { id }, omit: { data: true } });
  if (!d) throw new HttpError(404, "Document not found");
  const a = await docAccess(ctx, d);
  if (!a.canEdit && d.createdById !== ctx.user.id) throw new HttpError(403, "You cannot remove this document");
  await db.partDocument.delete({ where: { id } });
  await audit({ workspaceId: d.workspaceId, projectId: d.projectId, actorId: ctx.user.id, type: "document.remove", data: { title: d.title, scope: d.scope } });
  return { ok: true };
});
