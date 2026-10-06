import { route } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { visibleWhere } from "@/lib/library/access";

export const runtime = "nodejs";

/**
 * First datasheet link per placed component, library element and part number (for the BOM):
 * absolute links to Volt (sign-in required) or to the manufacturer.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view")) throw new HttpError(403, "No access");
  const origin = process.env.AUTH_URL?.replace(/\/$/, "") || new URL(req.url).origin;
  const href = (d: { id: string; url: string | null }) => d.url ?? `${origin}/api/documents/${d.id}/file`;
  const rank = (k: string) => (k === "DATASHEET" ? 0 : k === "SPEC" ? 1 : 2);
  const sorted = <T extends { kind: string; createdAt: Date }>(a: T[]) => [...a].sort((x, y) => rank(x.kind) - rank(y.kind) || x.createdAt.getTime() - y.createdAt.getTime());
  const own = sorted(await db.partDocument.findMany({ where: { scope: "COMPONENT", projectId: id }, select: { id: true, url: true, kind: true, createdAt: true, elementId: true, partNumber: true } }));
  const lib = sorted(await db.partDocument.findMany({ where: { scope: "LIBRARY", workspaceId: ctx.workspace.id, libraryElement: visibleWhere(ctx, { includeDeprecated: true }) }, select: { id: true, url: true, kind: true, createdAt: true, libraryElementId: true, partNumber: true } }));
  const byElement: Record<string, string> = {}, byLibrary: Record<string, string> = {}, byPart: Record<string, string> = {};
  for (const d of own) if (d.elementId && !byElement[d.elementId]) byElement[d.elementId] = href(d);
  for (const d of lib) if (d.libraryElementId && !byLibrary[d.libraryElementId]) byLibrary[d.libraryElementId] = href(d);
  for (const d of [...own, ...lib]) if (d.partNumber && !byPart[d.partNumber]) byPart[d.partNumber] = href(d);
  return { byElement, byLibrary, byPart };
});
