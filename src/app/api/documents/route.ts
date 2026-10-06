import { z } from "zod";
import { formData, route } from "@/lib/api";
import { apiCtx, can, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { MAX_ATTACHMENT, readUpload } from "@/lib/uploads";
import { loadElement, isGuestCtx } from "@/lib/library/access";
import { componentDocs, docDto, DOC_KINDS } from "@/lib/documents";

export const runtime = "nodejs";

/** documents of a placed component: ?projectId=&elementId=[&libraryElementId=&partNumber=] */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  const u = new URL(req.url).searchParams;
  const projectId = u.get("projectId"), elementId = u.get("elementId");
  if (!projectId || !elementId) throw new HttpError(400, "projectId and elementId are required");
  return componentDocs(ctx, { projectId, elementId, libraryElementId: u.get("libraryElementId"), partNumber: u.get("partNumber") });
});

const Meta = z.object({
  scope: z.enum(["LIBRARY", "COMPONENT"]),
  libraryElementId: z.string().optional(),
  projectId: z.string().optional(),
  elementId: z.string().max(100).optional(),
  kind: z.enum(DOC_KINDS).default("DATASHEET"),
  title: z.string().trim().max(200).optional(),
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((x) => !x || /^https?:\/\//i.test(x), "Links must start with http:// or https://")
    .optional(),
  manufacturer: z.string().trim().max(200).optional(),
  partNumber: z.string().trim().max(200).optional(),
});

/** add a file (multipart "file") or a link ("url") */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  rateLimit(`doc:${ctx.user.id}`, 60);
  const fd = await formData(req, MAX_ATTACHMENT + 64 * 1024, "File");
  const m = Meta.parse(Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string" && v !== "")));
  const file = fd.get("file");
  if (!(file instanceof File) && !m.url) throw new HttpError(400, "Upload a file or enter a link");
  let projectId: string | null = null;
  if (m.scope === "LIBRARY") {
    if (!m.libraryElementId) throw new HttpError(400, "libraryElementId is required");
    const a = await loadElement(ctx, m.libraryElementId);
    // documents do not change the symbol: anyone who may publish to the library can add them
    if (!a.canEdit && (isGuestCtx(ctx) || !can(ctx, "library.publish"))) throw new HttpError(403, "You cannot add documents to this library element");
  } else {
    if (!m.projectId || !m.elementId) throw new HttpError(400, "projectId and elementId are required");
    const p = await loadProject(ctx, m.projectId);
    if (!p.can("project.edit")) throw new HttpError(403, "You cannot add documents in this project");
    projectId = m.projectId;
  }
  const up = file instanceof File ? await readUpload(file) : null;
  const title = m.title || up?.filename || (m.url ? new URL(m.url).pathname.split("/").pop() || new URL(m.url).hostname : "Document");
  const d = await db.partDocument.create({
    data: {
      workspaceId: ctx.workspace.id,
      scope: m.scope,
      libraryElementId: m.scope === "LIBRARY" ? m.libraryElementId : null,
      projectId,
      elementId: m.scope === "COMPONENT" ? m.elementId : null,
      kind: m.kind,
      title,
      url: up ? null : m.url,
      filename: up?.filename,
      mime: up?.mime,
      size: up?.size,
      sha256: up?.sha256,
      data: up?.data,
      manufacturer: m.manufacturer || null,
      partNumber: m.partNumber || null,
      createdById: ctx.user.id,
    },
    omit: { data: true },
  });
  await audit({ workspaceId: ctx.workspace.id, projectId, actorId: ctx.user.id, type: "document.add", data: { title, kind: m.kind, scope: m.scope, partNumber: m.partNumber } });
  return { document: docDto(d, new Map([[ctx.user.id, ctx.user.name]]), m.scope === "LIBRARY" ? "library" : "component") };
});
