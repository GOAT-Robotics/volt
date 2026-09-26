import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { parseDoc } from "@/lib/versioning";
import { EMPTY_TEMPLATE, parseTemplateContent, templateFromDoc } from "@/lib/templates";
import { parseHistory, pushHistory } from "@/lib/styletemplates";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const rows = await db.projectTemplate.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return {
    templates: rows.map((t) => {
      const c = parseTemplateContent(t.content);
      return { id: t.id, name: t.name, description: t.description, version: t.version, status: t.status, isDefault: t.isDefault, updatedAt: t.updatedAt.toISOString(), content: { ...c, doc: undefined, hasDoc: !!c.doc, docPages: c.doc?.pages.length ?? 0 }, history: parseHistory(t.history).map(({ content: _c, ...h }) => h) };
    }),
  };
});

/** Create blank or from an existing project version. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(""), fromVersionId: z.string().nullish() }));
  let content = EMPTY_TEMPLATE;
  let source: string | undefined;
  if (b.fromVersionId) {
    const v = await db.version.findUnique({ where: { id: b.fromVersionId } });
    if (!v) throw new HttpError(404, "Version not found");
    const { project } = await loadProject(ctx, v.projectId);
    if (project.workspaceId !== ctx.workspace.id) throw new HttpError(404, "Version not found");
    content = templateFromDoc(parseDoc(v.doc));
    source = `${project.name} v${v.label}`;
  }
  const t = await db.projectTemplate.create({
    data: { workspaceId: ctx.workspace.id, name: b.name, description: b.description, content: JSON.stringify(content), ownerId: ctx.user.id, history: pushHistory("[]", { version: 1, action: b.fromVersionId ? "copy" : "create", at: new Date().toISOString(), by: ctx.user.name, note: source ? `From ${source}` : undefined }) },
  });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "template.update", data: { action: "create", name: b.name, from: source } });
  return { id: t.id };
});
