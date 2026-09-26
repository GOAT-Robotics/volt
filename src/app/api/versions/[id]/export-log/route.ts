import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const Body = z.object({ format: z.string().max(20), pages: z.number().int().min(0).max(100_000).optional(), markup: z.boolean().optional() });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.canExport) throw new HttpError(403, "Export is not permitted for your role");
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "project.export", data: { format: b.format, pages: b.pages, markup: !!b.markup, label: a.version.label } });
  return { ok: true };
});
