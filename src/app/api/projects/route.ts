import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, assertCan, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { projectScope } from "@/lib/access";
import { baseStylesFor, createProjectRecord, templateFor } from "@/lib/projects";
import { docFromTemplate } from "@/lib/templates";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const ctx = await apiCtx();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const state = url.searchParams.get("state") === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
  const rows = await db.project.findMany({
    where: { AND: [projectScope(ctx), { state }, q ? { OR: [{ name: { contains: q } }, { number: { contains: q } }, { tags: { contains: q } }] } : {}] },
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: { versions: { orderBy: { seq: "desc" }, take: 1, omit: { doc: true } } },
  });
  return { projects: rows.map((p) => ({ id: p.id, name: p.name, number: p.number, tags: J.parse<string[]>(p.tags, []), state: p.state, updatedAt: p.updatedAt.toISOString(), latest: p.versions[0] ? { id: p.versions[0].id, label: p.versions[0].label, status: p.versions[0].status } : null })) };
});

const Scheme = z.enum(["INTEGER", "DECIMAL", "LETTER", "CUSTOM"]);
const Body = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  number: z.string().trim().max(60).optional(),
  description: z.string().max(5000).optional(),
  folderId: z.string().nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  versionScheme: Scheme.default("INTEGER"),
  customScheme: z.string().trim().max(40).nullish(),
  templateId: z.string().nullish(),
  props: z.record(z.string(), z.string().max(500)).optional(),
});

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertCan(ctx, "project.create");
  const b = await body(req, Body);
  if (b.versionScheme === "CUSTOM" && !b.customScheme?.includes("{n}")) throw new HttpError(400, "Custom scheme must contain {n}, e.g. R{n}");
  if (b.folderId && !(await db.folder.findFirst({ where: { id: b.folderId, workspaceId: ctx.workspace.id } }))) throw new HttpError(400, "Folder not found");
  if (b.number && (await db.project.findFirst({ where: { workspaceId: ctx.workspace.id, number: b.number } }))) throw new HttpError(409, `Project number ${b.number} is already used`);
  let tmpl = null;
  if (b.templateId) {
    const t = await db.projectTemplate.findFirst({ where: { id: b.templateId, workspaceId: ctx.workspace.id, status: "APPROVED" } });
    if (!t) throw new HttpError(400, "Project template not found or not approved");
    tmpl = await templateFor(ctx.workspace.id, t.id);
  }
  const props = Object.fromEntries(Object.entries(b.props ?? {}).map(([k, v]) => [k.trim(), v.trim()]).filter(([k]) => k));
  const missing = (tmpl?.requiredFields ?? []).filter((f) => !props[f]);
  if (missing.length) throw new HttpError(400, `Required fields missing: ${missing.join(", ")}`);
  const base = await baseStylesFor(ctx.workspace.id, tmpl?.styleTemplateId);
  const doc = docFromTemplate(b.name, tmpl, base.styles, props);
  if (base.ref) doc.baseStylesRef = base.ref;
  const { project, version } = await createProjectRecord({
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    name: b.name,
    number: b.number,
    description: b.description,
    folderId: b.folderId,
    tags: b.tags,
    versionScheme: b.versionScheme,
    customScheme: b.versionScheme === "CUSTOM" ? b.customScheme : null,
    templateId: b.templateId ?? null,
    doc,
    summary: "Initial version",
  });
  await audit({ workspaceId: ctx.workspace.id, projectId: project.id, versionId: version.id, actorId: ctx.user.id, type: "project.create", data: { name: b.name, number: b.number, template: b.templateId ?? null } });
  return { id: project.id, versionId: version.id, label: version.label };
});
