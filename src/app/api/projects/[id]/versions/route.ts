import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { docHash, nextLabel, parseDoc, reindexVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { applyExpiry } from "@/lib/workflow";
import { WORKING } from "@/lib/projects";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  const rows = await db.version.findMany({ where: { projectId: id }, omit: { doc: true }, orderBy: { seq: "desc" } });
  await Promise.all(rows.filter((r) => ["IN_REVIEW", "APPROVED"].includes(r.status)).map((r) => applyExpiry(r.id)));
  const fresh = await db.version.findMany({ where: { projectId: id }, omit: { doc: true }, orderBy: { seq: "desc" } });
  const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(fresh.map((r) => r.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const labels = new Map(fresh.map((r) => [r.id, r.label]));
  return {
    versions: fresh.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      summary: r.summary,
      description: r.description,
      ticket: r.ticket,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      createdBy: users.get(r.createdById) ?? "",
      parentLabel: r.parentId ? labels.get(r.parentId) ?? null : null,
      releasedAt: r.releasedAt?.toISOString() ?? null,
    })),
  };
});

const Body = z.object({
  parentId: z.string().min(1),
  summary: z.string().trim().min(1, "Summary is required").max(500),
  description: z.string().max(10_000).optional(),
  ticket: z.string().trim().max(200).optional(),
});

/** Start a new version from an existing one (copies its document). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const { project, can } = await loadProject(ctx, id);
  if (!can("project.edit") && !can("project.manage")) throw new HttpError(403, "You cannot start versions in this project");
  if (project.state !== "ACTIVE") throw new HttpError(409, "Project is archived");
  const parent = await db.version.findUnique({ where: { id: b.parentId } });
  if (!parent || parent.projectId !== id) throw new HttpError(404, "Parent version not found");
  const working = await db.version.findFirst({ where: { projectId: id, status: { in: WORKING } }, orderBy: { seq: "desc" } });
  if (working) throw new HttpError(409, `Version ${working.label} is already in progress — continue working there`, "WORKING_EXISTS");
  const doc = parseDoc(parent.doc);
  const v = await db.$transaction(async (tx) => {
    const last = await tx.version.findFirst({ where: { projectId: id }, orderBy: { seq: "desc" } });
    const seq = (last?.seq ?? 0) + 1;
    const label = nextLabel(project.versionScheme, last?.label ?? null, seq, project.customScheme);
    const clash = await tx.version.findFirst({ where: { projectId: id, label } });
    return tx.version.create({
      data: {
        projectId: id,
        seq,
        label: clash ? `${label}-${seq}` : label,
        parentId: parent.id,
        status: "DRAFT",
        summary: b.summary,
        description: b.description ?? "",
        ticket: b.ticket || null,
        doc: parent.doc,
        docHash: docHash(doc),
        createdById: ctx.user.id,
      },
    });
  });
  await db.project.update({ where: { id }, data: { updatedAt: new Date() } });
  await reindexVersion(v.id, id, doc);
  await audit({ workspaceId: project.workspaceId, projectId: id, versionId: v.id, actorId: ctx.user.id, type: "version.create", data: { label: v.label, parent: parent.label, summary: b.summary, ticket: b.ticket } });
  return { id: v.id, label: v.label };
});
