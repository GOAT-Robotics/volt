/**
 * Part documents (datasheets, spec sheets …) on library elements and on placed components.
 * A placed component shows its own documents, those of the library element it came from, and
 * documents of other parts with the same part number in the workspace.
 */
import "server-only";
import { db } from "./db";
import { can, HttpError, loadProject, type Ctx } from "./session";
import { isGuestCtx, loadElement } from "./library/access";

export const DOC_KINDS = ["DATASHEET", "SPEC", "MANUAL", "CERTIFICATE", "DRAWING", "CAD", "OTHER"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

type Row = Awaited<ReturnType<typeof db.partDocument.findFirstOrThrow>>;
export function docDto(d: Omit<Row, "data">, names: Map<string, string>, origin: "component" | "library" | "part") {
  return {
    id: d.id,
    scope: d.scope,
    origin,
    kind: d.kind,
    title: d.title,
    url: d.url,
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    manufacturer: d.manufacturer,
    partNumber: d.partNumber,
    href: d.url ?? `/api/documents/${d.id}/file`,
    createdBy: names.get(d.createdById) ?? "",
    createdAt: d.createdAt.toISOString(),
  };
}
export type PartDocDto = ReturnType<typeof docDto>;

async function names(rows: { createdById: string }[]) {
  return new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

/** May the user read / change this document? */
export async function docAccess(ctx: Ctx, d: Pick<Row, "scope" | "libraryElementId" | "projectId" | "workspaceId" | "createdById">) {
  if (d.workspaceId !== ctx.workspace.id) throw new HttpError(404, "Document not found");
  if (d.scope === "LIBRARY" && d.libraryElementId) {
    const a = await loadElement(ctx, d.libraryElementId);
    if (!a.canView) throw new HttpError(404, "Document not found");
    return { canEdit: a.canEdit || d.createdById === ctx.user.id };
  }
  if (d.projectId) {
    const { can } = await loadProject(ctx, d.projectId);
    if (!can("project.view")) throw new HttpError(404, "Document not found");
    return { canEdit: can("project.edit") };
  }
  throw new HttpError(404, "Document not found");
}

/** documents for one placed component (own + library + same part number) */
export async function componentDocs(ctx: Ctx, input: { projectId: string; elementId: string; libraryElementId?: string | null; partNumber?: string | null }) {
  const { can } = await loadProject(ctx, input.projectId);
  if (!can("project.view")) throw new HttpError(403, "No access");
  const own = await db.partDocument.findMany({ where: { scope: "COMPONENT", projectId: input.projectId, elementId: input.elementId }, omit: { data: true }, orderBy: { createdAt: "asc" } });
  let lib: typeof own = [];
  if (input.libraryElementId) {
    const a = await loadElement(ctx, input.libraryElementId).catch(() => null);
    if (a?.canView) lib = await db.partDocument.findMany({ where: { scope: "LIBRARY", libraryElementId: input.libraryElementId }, omit: { data: true }, orderBy: { createdAt: "asc" } });
  }
  const pn = input.partNumber?.trim();
  let part: typeof own = [];
  if (pn) {
    const seen = new Set([...own, ...lib].map((d) => d.id));
    const rows = await db.partDocument.findMany({ where: { workspaceId: ctx.workspace.id, partNumber: pn }, omit: { data: true }, orderBy: { createdAt: "asc" }, take: 20 });
    // only documents the user may see anyway
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      const ok = await docAccess(ctx, r).then(() => true).catch(() => false);
      if (ok) part.push(r);
    }
    part = part.filter((r, i, a) => a.findIndex((x) => (x.sha256 && x.sha256 === r.sha256) || (x.url && x.url === r.url)) === i);
  }
  const n = await names([...own, ...lib, ...part]);
  return {
    documents: [...own.map((d) => docDto(d, n, "component")), ...lib.map((d) => docDto(d, n, "library")), ...part.map((d) => docDto(d, n, "part"))],
    canEdit: can("project.edit"),
  };
}

export async function libraryDocs(ctx: Ctx, libraryElementId: string) {
  const a = await loadElement(ctx, libraryElementId);
  if (!a.canView) throw new HttpError(404, "Element not found");
  const rows = await db.partDocument.findMany({ where: { scope: "LIBRARY", libraryElementId }, omit: { data: true }, orderBy: { createdAt: "asc" } });
  const n = await names(rows);
  return { documents: rows.map((d) => docDto(d, n, "library")), canEdit: a.canEdit || (!isGuestCtx(ctx) && can(ctx, "library.publish")) };
}
