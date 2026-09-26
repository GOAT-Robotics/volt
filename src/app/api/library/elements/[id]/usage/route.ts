import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { assertMember, loadElement } from "@/lib/library/access";

export const runtime = "nodejs";

/** Where is this element used? (project versions whose document references it) */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  await loadElement(ctx, id);
  const rows = await db.version.findMany({
    where: { project: { workspaceId: ctx.workspace.id }, OR: [{ doc: { contains: `"libraryElementId":"${id}"` } }, { doc: { contains: `"blockId":"${id}"` } }] },
    select: { id: true, label: true, status: true, project: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return { count: rows.length, usages: rows.map((r) => ({ versionId: r.id, label: r.label, status: r.status, projectId: r.project.id, projectName: r.project.name })) };
});
