import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { parseTemplateContent } from "@/lib/templates";
import { pushHistory } from "@/lib/styletemplates";

export const runtime = "nodejs";

const Rule = z.object({
  id: z.string().max(80).default(""),
  match: z.string().trim().min(1).max(80),
  prefix: z.string().max(20),
  scope: z.enum(["page", "project", "location"]),
  format: z.string().trim().min(1).max(80),
  start: z.number().int().min(0).max(1_000_000),
});
const Content = z.object({
  pages: z.array(z.object({ title: z.string().trim().min(1).max(120) })).max(200),
  titleBlockFields: z.record(z.string().trim().min(1).max(60), z.string().max(500)),
  styleTemplateId: z.string().nullish(),
  numbering: z.array(Rule).max(50),
  requiredFields: z.array(z.string().trim().min(1).max(60)).max(50),
  approval: z
    .object({
      minApprovals: z.number().int().min(1).max(20).optional(),
      sequentialDefault: z.boolean().optional(),
      requireCommentsResolved: z.boolean().optional(),
      signatureRequiredForRelease: z.boolean().optional(),
      requiredSignatories: z.number().int().min(0).max(20).optional(),
      allowSelfApproval: z.boolean().optional(),
    })
    .default({}),
  keepSeedDoc: z.boolean().default(true),
});

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  content: Content.optional(),
  action: z.enum(["approve", "setDefault", "retire", "reactivate"]).optional(),
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const { id } = await params;
  const b = await body(req, Patch, 20 * 1024 * 1024);
  const t = await db.projectTemplate.findFirst({ where: { id, workspaceId: ctx.workspace.id } });
  if (!t) throw new HttpError(404, "Project template not found");
  const at = new Date().toISOString();
  if (b.content || b.name !== undefined || b.description !== undefined) {
    const old = parseTemplateContent(t.content);
    let content = old;
    if (b.content) {
      if (b.content.styleTemplateId && !(await db.styleTemplate.findFirst({ where: { id: b.content.styleTemplateId, workspaceId: ctx.workspace.id } }))) throw new HttpError(400, "Style template not found");
      const { keepSeedDoc, ...rest } = b.content;
      const seed = keepSeedDoc ? old.doc : null;
      content = { ...rest, styles: old.styles, doc: seed };
      // keep the seed document's page list in sync with the edited page structure
      if (seed) {
        const keep = rest.pages.map((p) => p.title);
        const pages = [...seed.pages].sort((a, b2) => a.order - b2.order);
        seed.pages = keep.map((title, i) => {
          const pg = pages[i];
          return pg ? { ...pg, title, order: i } : { ...structuredClone(pages[0]), id: `tpl-${i}-${Date.now()}`, title, order: i, elements: [], wires: [], junctions: [], texts: [], shapes: [] };
        });
      }
    }
    const version = t.version + 1;
    await db.projectTemplate.update({
      where: { id },
      data: {
        ...(b.name && { name: b.name }),
        ...(b.description !== undefined && { description: b.description }),
        content: JSON.stringify(content),
        version,
        status: "DRAFT",
        history: pushHistory(t.history, { version, action: "edit", at, by: ctx.user.name, name: b.name ?? t.name }),
      },
    });
    await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "template.update", data: { action: "edit", name: b.name ?? t.name, version } });
    return { ok: true, version };
  }
  switch (b.action) {
    case "approve":
      await db.projectTemplate.update({ where: { id }, data: { status: "APPROVED", history: pushHistory(t.history, { version: t.version, action: "approve", at, by: ctx.user.name }) } });
      break;
    case "setDefault":
      if (t.status !== "APPROVED") throw new HttpError(409, "Approve the template before making it the default");
      await db.$transaction([
        db.projectTemplate.updateMany({ where: { workspaceId: ctx.workspace.id, isDefault: true }, data: { isDefault: false } }),
        db.projectTemplate.update({ where: { id }, data: { isDefault: true, history: pushHistory(t.history, { version: t.version, action: "default", at, by: ctx.user.name }) } }),
      ]);
      break;
    case "retire":
      await db.projectTemplate.update({ where: { id }, data: { status: "RETIRED", isDefault: false, history: pushHistory(t.history, { version: t.version, action: "retire", at, by: ctx.user.name }) } });
      break;
    case "reactivate":
      await db.projectTemplate.update({ where: { id }, data: { status: "DRAFT" } });
      break;
    default:
      throw new HttpError(400, "Nothing to change");
  }
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "template.update", data: { action: b.action, name: t.name, version: t.version } });
  return { ok: true };
});
