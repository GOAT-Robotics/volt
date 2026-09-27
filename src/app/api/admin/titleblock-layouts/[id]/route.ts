import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { pushHistory } from "@/lib/styletemplates";
import { checkLayoutXml, MAX_LAYOUT_XML } from "@/lib/titleblock-layouts";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const t = await db.titleBlockLayout.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
  if (!t) throw new HttpError(404, "Title block layout not found");
  return { id: t.id, name: t.name, version: t.version, xml: t.xml };
});

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  xml: z.string().max(MAX_LAYOUT_XML).optional(),
  note: z.string().max(500).optional(),
  action: z.enum(["approve", "setDefault", "retire", "reactivate"]).optional(),
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const b = await body(req, Patch, MAX_LAYOUT_XML + 64 * 1024);
  const t = await db.titleBlockLayout.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
  if (!t) throw new HttpError(404, "Title block layout not found");
  const at = new Date().toISOString();
  if (b.xml !== undefined || (b.name && b.name !== t.name)) {
    const name = b.name ?? t.name;
    if (name !== t.name && (await db.titleBlockLayout.findFirst({ where: { workspaceId: ctx.workspace.id, name, id: { not: id } } }))) throw new HttpError(409, `A layout called “${name}” already exists`);
    const xml = checkLayoutXml(b.xml ?? t.xml, name);
    // every edit is a new version and needs approval; projects keep using the last approved one
    const version = t.version + 1;
    await db.titleBlockLayout.update({ where: { id }, data: { name, xml, version, status: "DRAFT", history: pushHistory(t.history, { version, action: "edit", at, by: ctx.user.name, note: b.note, name }) } });
    await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "style.update", data: { action: "edit", titleBlockLayout: name, version } });
    return { ok: true, version };
  }
  switch (b.action) {
    case "approve":
      if (t.status === "APPROVED") throw new HttpError(409, "Already approved");
      await db.titleBlockLayout.update({ where: { id }, data: { status: "APPROVED", history: pushHistory(t.history, { version: t.version, action: "approve", at, by: ctx.user.name, content: t.xml }) } });
      break;
    case "setDefault":
      if (t.status === "RETIRED") throw new HttpError(409, "A retired layout cannot be the default");
      if (t.status !== "APPROVED" && !t.history.includes('"approve"')) throw new HttpError(409, "Approve the layout before making it the default");
      await db.$transaction([
        db.titleBlockLayout.updateMany({ where: { workspaceId: ctx.workspace.id, isDefault: true }, data: { isDefault: false } }),
        db.titleBlockLayout.update({ where: { id }, data: { isDefault: true, history: pushHistory(t.history, { version: t.version, action: "default", at, by: ctx.user.name }) } }),
      ]);
      break;
    case "retire":
      await db.titleBlockLayout.update({ where: { id }, data: { status: "RETIRED", isDefault: false, history: pushHistory(t.history, { version: t.version, action: "retire", at, by: ctx.user.name }) } });
      break;
    case "reactivate":
      await db.titleBlockLayout.update({ where: { id }, data: { status: "DRAFT" } });
      break;
    default:
      throw new HttpError(400, "Nothing to change");
  }
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "style.update", data: { action: b.action, titleBlockLayout: t.name, version: t.version } });
  return { ok: true };
});
