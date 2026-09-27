import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCtx, requireCtx, loadProject, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { applyProjectExpiry } from "@/lib/workflow";
import { effectivePolicy } from "@/lib/projects";
import { eligibleSignatories } from "@/lib/signing/service";
import { auditLabel, describeAudit } from "@/lib/describe";
import { isAdmin, isGuestCtx } from "@/lib/access";
import { parseRoles } from "@/lib/roles";
import type { CompatReport } from "@/core/model";
import { projectPreview } from "@/lib/og/preview";
import { previewMetadata } from "@/lib/og/meta";
import { ProjectView, type ProjectData } from "./ProjectView";

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  const ctx = await getCtx();
  if (!ctx) return { title: "Project" };
  const p = await loadProject(ctx, projectId).catch(() => null);
  if (!p) return { title: "Project" };
  const pv = await projectPreview(projectId).catch(() => null);
  return pv ? previewMetadata(pv, { title: p.project.name }) : { title: p.project.name };
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const { tab } = await searchParams;
  const ctx = await requireCtx();
  let lp;
  try {
    lp = await loadProject(ctx, projectId);
  } catch (e) {
    if (e instanceof HttpError) notFound();
    throw e;
  }
  const { project, can } = lp;
  if (!can("project.view") && !can("review.comment")) notFound();

  await applyProjectExpiry(projectId);
  // comment-only guests: the versions they review, not the project's records
  const full = can("project.view");

  const [versions, reviews, signatures, events, members, attachments, imports, folders, fav, policy] = await Promise.all([
    db.version.findMany({ where: { projectId }, omit: { doc: true }, orderBy: { seq: "desc" } }),
    db.review.findMany({ where: { version: { projectId } }, include: { assignments: { orderBy: { order: "asc" } } }, orderBy: { createdAt: "desc" } }),
    db.signature.findMany({ where: { version: { projectId } }, orderBy: [{ createdAt: "desc" }, { order: "asc" }] }),
    !full ? [] : db.auditEvent.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 300, include: { actor: { select: { name: true } } } }),
    db.projectMember.findMany({ where: { projectId }, include: { user: true } }),
    db.attachment.findMany({ where: { projectId, ...(full ? {} : { ownerType: { in: ["REVIEW", "COMMENT"] } }) }, omit: { data: true }, orderBy: { createdAt: "desc" } }),
    db.importRecord.findMany({ where: { projectId }, omit: { original: true }, orderBy: { createdAt: "desc" } }),
    isGuestCtx(ctx) ? [] : db.folder.findMany({ where: { workspaceId: project.workspaceId }, orderBy: { name: "asc" } }),
    db.favorite.findUnique({ where: { userId_projectId: { userId: ctx.user.id, projectId } } }),
    effectivePolicy(project, ctx.settings),
  ]);
  const uids = new Set<string>();
  versions.forEach((v) => uids.add(v.createdById));
  reviews.forEach((r) => (uids.add(r.submittedById), r.assignments.forEach((a) => [a.userId, a.decidedById].forEach((x) => x && uids.add(x)))));
  signatures.forEach((s) => (uids.add(s.signatoryId), uids.add(s.requestedById)));
  attachments.forEach((a) => uids.add(a.userId));
  const users = new Map((await db.user.findMany({ where: { id: { in: [...uids] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
  const nm = (id: string | null | undefined) => (id ? users.get(id)?.name ?? "Unknown" : null);
  const labelOf = new Map(versions.map((v) => [v.id, v.label]));
  const canManage = can("project.manage");
  const canExport = isGuestCtx(ctx) ? ctx.settings.exports.guestCanExport : can("project.export") && (can("project.edit") || ctx.settings.exports.viewerCanExport);

  const data: ProjectData = {
    me: { id: ctx.user.id, isAdmin: isAdmin(ctx) && project.workspaceId === ctx.workspace.id },
    perms: { manage: canManage, edit: can("project.edit"), export: canExport, view: can("project.view") },
    project: {
      id: project.id,
      name: project.name,
      number: project.number,
      description: project.description,
      tags: J.parse<string[]>(project.tags, []),
      folderId: project.folderId,
      state: project.state,
      versionScheme: project.versionScheme,
      customScheme: project.customScheme,
      createdAt: project.createdAt.toISOString(),
      favorite: !!fav,
      hasRelease: versions.some((v) => v.releasedAt),
    },
    policy: { signatureRequiredForRelease: policy.signatureRequiredForRelease, requiredSignatories: policy.requiredSignatories, minApprovals: policy.minApprovals },
    folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, count: 0 })),
    versions: versions.map((v) => ({
      id: v.id,
      label: v.label,
      status: v.status,
      summary: v.summary,
      description: v.description,
      ticket: v.ticket,
      author: nm(v.createdById) ?? "",
      parentLabel: v.parentId ? labelOf.get(v.parentId) ?? null : null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
      submittedAt: v.submittedAt?.toISOString() ?? null,
      approvedAt: v.approvedAt?.toISOString() ?? null,
      signedAt: v.signedAt?.toISOString() ?? null,
      releasedAt: v.releasedAt?.toISOString() ?? null,
      endedAt: v.endedAt?.toISOString() ?? null,
      endReason: v.endReason,
      docHash: v.docHash,
      importId: imports.find((i) => i.versionId === v.id)?.id ?? null,
    })),
    reviews: reviews.map((r) => ({
      id: r.id,
      versionId: r.versionId,
      versionLabel: labelOf.get(r.versionId) ?? "",
      status: r.status,
      sequential: r.sequential,
      dueDate: r.dueDate?.toISOString() ?? null,
      instructions: r.instructions,
      submittedBy: nm(r.submittedById) ?? "",
      createdAt: r.createdAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
      assignments: r.assignments.map((a) => ({ id: a.id, order: a.order, who: a.userId ? nm(a.userId) ?? "Unknown" : a.groupName ?? a.groupId ?? "Group", isGroup: !a.userId, canApprove: a.canApprove, decision: a.decision, reason: a.reason, decidedBy: nm(a.decidedById), decidedAt: a.decidedAt?.toISOString() ?? null })),
    })),
    signatures: signatures.map((s) => ({
      id: s.id,
      versionId: s.versionId,
      versionLabel: labelOf.get(s.versionId) ?? "",
      status: s.status,
      order: s.order,
      purpose: s.purpose,
      signatory: users.get(s.signatoryId) ? { id: s.signatoryId, name: users.get(s.signatoryId)!.name, email: full ? users.get(s.signatoryId)!.email : "" } : { id: s.signatoryId, name: "Unknown", email: "" },
      requestedBy: nm(s.requestedById) ?? "",
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt?.toISOString() ?? null,
      signedAt: s.signedAt?.toISOString() ?? null,
      declineReason: s.declineReason,
      docHash: s.docHash,
      pdfHash: s.pdfHash,
      provider: s.provider,
      // signer IP, user agent and account ids: for project managers and the signatory
      evidence: canManage || s.signatoryId === ctx.user.id ? J.parse<Record<string, unknown> | null>(s.evidence, null) : null,
      seal: s.seal,
    })),
    activity: events.map((e) => ({ id: e.id, type: e.type, label: auditLabel(e.type), detail: describeAudit(e.type, { ...J.parse<Record<string, unknown>>(e.data, {}), ...(e.versionId && !J.parse<Record<string, unknown>>(e.data, {}).label && labelOf.get(e.versionId) ? { label: labelOf.get(e.versionId) } : {}) }), actor: e.actor?.name ?? "System", createdAt: e.createdAt.toISOString() })),
    members: members.map((m) => ({ userId: m.userId, name: m.user.name, email: full ? m.user.email : "", isGuest: m.user.isGuest, disabled: m.user.disabled, roles: parseRoles(m.roles) })),
    attachments: attachments.map((a) => ({ id: a.id, ownerType: a.ownerType, ownerId: a.ownerId, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256, uploadedBy: nm(a.userId) ?? "", uploadedById: a.userId, createdAt: a.createdAt.toISOString(), context: a.ownerType === "REVIEW" ? `Review of v${labelOf.get(reviews.find((r) => r.id === a.ownerId)?.versionId ?? "") ?? "?"}` : a.ownerType === "RELEASE" ? `v${labelOf.get(a.ownerId) ?? "?"}` : a.ownerType === "COMMENT" ? "Comment" : "Project" })),
    imports: imports.map((i) => ({ id: i.id, filename: i.filename, sha256: i.sha256, createdAt: i.createdAt.toISOString(), versionLabel: i.versionId ? labelOf.get(i.versionId) ?? null : null, report: J.parse<CompatReport | null>(i.report, null) })),
    eligibleSignatories: canManage ? await eligibleSignatories(project.workspaceId, projectId) : [],
  };
  return <ProjectView data={data} initialTab={tab ?? "versions"} />;
}
