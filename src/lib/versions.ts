import "server-only";
import { z } from "zod";
import { HttpError, loadProject, type Ctx } from "./session";
import { db } from "./db";
import { docHash, parseDoc, reindexVersion, withStoredSource } from "./versioning";
import { unpackDoc } from "./commits";
import type { Doc } from "@/core/model";
import { nextLineLabel } from "./variants";
import { notify } from "./notify";
import { audit } from "./audit";
import { WORKING } from "./projects";
import { flushLive } from "./live/hooks";

export const StartVersionBody = z.object({
  parentId: z.string().min(1),
  /** start from an older commit of the parent's history instead of its current state */
  fromCommitId: z.string().optional(),
  summary: z.string().trim().min(1, "Summary is required").max(500),
  description: z.string().max(10_000).optional(),
  ticket: z.string().trim().max(200).optional(),
});
export type StartVersion = z.infer<typeof StartVersionBody>;

/**
 * Start a new version from an existing one (copies its document). The new version continues the
 * parent's line (main line or variant). A signed parent cannot be changed or recalled any more: it
 * is marked obsolete and the new version replaces it.
 */
export async function startVersion(ctx: Ctx, id: string, b: StartVersion) {
  const { project, can } = await loadProject(ctx, id);
  if (!can("project.edit") && !can("project.manage")) throw new HttpError(403, "You cannot start versions in this project");
  if (project.state !== "ACTIVE") throw new HttpError(409, "Project is archived");
  let parentId = b.parentId;
  let fromCommit: { id: string; doc: Doc } | null = null;
  if (b.fromCommitId) {
    const c = await db.commit.findUnique({ where: { id: b.fromCommitId }, select: { id: true, projectId: true, versionId: true, data: true } });
    if (!c || c.projectId !== id) throw new HttpError(404, "Commit not found");
    parentId = c.versionId;
    fromCommit = { id: c.id, doc: unpackDoc(c.data) };
  }
  await flushLive(parentId);
  const parent = await db.version.findUnique({ where: { id: parentId } });
  if (!parent || parent.projectId !== id) throw new HttpError(404, "Parent version not found");
  const variant = parent.variantId ? await db.variant.findUnique({ where: { id: parent.variantId } }) : null;
  if (variant?.state === "ARCHIVED") throw new HttpError(409, `Variant ${variant.name} is archived — restore it to continue its line`);
  const working = await db.version.findFirst({ where: { projectId: id, variantId: parent.variantId, status: { in: WORKING } }, orderBy: { seq: "desc" } });
  if (working) throw new HttpError(409, `Version ${working.label} is already in progress${variant ? ` for ${variant.name}` : ""} — continue working there`, "WORKING_EXISTS");
  const parentDoc = parseDoc(parent.doc);
  // an older commit: its drawing, with the project's original imported file re-attached
  const doc = fromCommit ? withStoredSource(fromCommit.doc, parentDoc.qet?.source) : parentDoc;
  const docJson = fromCommit ? JSON.stringify(doc) : parent.doc;
  const now = new Date();
  const v = await db.$transaction(async (tx) => {
    const last = await tx.version.findFirst({ where: { projectId: id }, orderBy: { seq: "desc" } });
    const seq = (last?.seq ?? 0) + 1;
    const label = await nextLineLabel(tx, project, parent.variantId, seq);
    const created = await tx.version.create({
      data: {
        projectId: id,
        variantId: parent.variantId,
        seq,
        label,
        parentId: parent.id,
        status: "DRAFT",
        summary: b.summary,
        description: b.description ?? "",
        ticket: b.ticket || null,
        doc: docJson,
        docHash: docHash(doc),
        createdById: ctx.user.id,
        baseCommitId: fromCommit?.id ?? parent.headCommitId,
      },
    });
    if (parent.status === "SIGNED") await tx.version.update({ where: { id: parent.id }, data: { status: "OBSOLETE", endedAt: now, endReason: `Replaced by v${label}` } });
    return created;
  });
  await db.project.update({ where: { id }, data: { updatedAt: now } });
  await reindexVersion(v.id, id, doc);
  const base = { workspaceId: project.workspaceId, projectId: id, actorId: ctx.user.id };
  await audit({ ...base, versionId: v.id, type: "version.create", data: { label: v.label, parent: parent.label, summary: b.summary, ticket: b.ticket, variant: variant?.code, fromCommit: b.fromCommitId } });
  if (parent.status === "SIGNED") {
    await audit({ ...base, versionId: parent.id, type: "version.obsolete", data: { label: parent.label, by: v.label, reason: `Replaced by v${v.label}` } });
    const members = await db.projectMember.findMany({ where: { projectId: id }, select: { userId: true } });
    await notify(members.map((m) => m.userId).filter((u) => u !== ctx.user.id), {
      type: "version.superseded",
      title: `${project.name} v${parent.label} is obsolete`,
      body: `It was signed and is being replaced by v${v.label}: ${b.summary}`,
      link: `/projects/${id}?tab=versions`,
      workspaceId: project.workspaceId,
    });
  }
  return { id: v.id, label: v.label, obsoleted: parent.status === "SIGNED" ? parent.label : null };
}
