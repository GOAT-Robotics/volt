import "server-only";
import { db } from "./db";
import { audit } from "./audit";
import { notify } from "./notify";
import { HttpError, type Ctx } from "./session";
import { effectivePolicy } from "./projects";
import { docHash, parseDoc } from "./versioning";

async function audience(projectId: string, extra: string[] = []) {
  const members = await db.projectMember.findMany({ where: { projectId }, select: { userId: true } });
  const favs = await db.favorite.findMany({ where: { projectId }, select: { userId: true } });
  return [...new Set([...members.map((m) => m.userId), ...favs.map((f) => f.userId), ...extra])];
}

export async function releaseVersion(ctx: Ctx, versionId: string, note: string) {
  const v = await db.version.findUnique({ where: { id: versionId }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  const policy = await effectivePolicy(v.project, ctx.settings);
  const allowed = policy.signatureRequiredForRelease ? ["SIGNED"] : ["APPROVED", "SIGNED"];
  if (!allowed.includes(v.status)) {
    throw new HttpError(409, policy.signatureRequiredForRelease && v.status === "APPROVED" ? "Workspace policy requires signatures before release" : `A ${v.status.toLowerCase().replace("_", " ")} version cannot be released`);
  }
  if (v.docHash && v.docHash !== docHash(parseDoc(v.doc))) throw new HttpError(409, "Document integrity check failed — stored hash differs");
  const now = new Date();
  // only the same line: a variant's release does not replace the main release, nor the other way round
  const prev = await db.version.findMany({ where: { projectId: v.projectId, variantId: v.variantId, status: "RELEASED", id: { not: v.id } }, omit: { doc: true } });
  // signed but never released versions before this one are dead ends now
  const stale = await db.version.findMany({ where: { projectId: v.projectId, variantId: v.variantId, status: "SIGNED", seq: { lt: v.seq } }, omit: { doc: true } });
  await db.$transaction([
    db.version.update({ where: { id: v.id }, data: { status: "RELEASED", releasedAt: now } }),
    ...prev.map((p) => db.version.update({ where: { id: p.id }, data: { status: "SUPERSEDED", endedAt: now, endReason: `Superseded by v${v.label}` } })),
    ...stale.map((p) => db.version.update({ where: { id: p.id }, data: { status: "OBSOLETE", endedAt: now, endReason: `Replaced by v${v.label}` } })),
    db.project.update({ where: { id: v.projectId }, data: { updatedAt: now } }),
  ]);
  const base = { workspaceId: v.project.workspaceId, projectId: v.projectId, actorId: ctx.user.id };
  await audit({ ...base, versionId: v.id, type: "version.release", data: { label: v.label, note: note || undefined, docHash: v.docHash } });
  for (const p of prev) await audit({ ...base, versionId: p.id, type: "version.supersede", data: { label: p.label, by: v.label, reason: `Superseded by v${v.label}` } });
  for (const p of stale) await audit({ ...base, versionId: p.id, type: "version.obsolete", data: { label: p.label, by: v.label, reason: `Replaced by v${v.label}` } });
  const who = await audience(v.projectId, [v.createdById]);
  await notify(who.filter((u) => u !== ctx.user.id), {
    type: "version.released",
    title: `${v.project.name} v${v.label} released`,
    body: note || v.summary,
    link: `/projects/${v.projectId}?tab=versions`,
    workspaceId: v.project.workspaceId,
  });
  if (prev.length) {
    await notify(who.filter((u) => u !== ctx.user.id), {
      type: "version.superseded",
      title: `${v.project.name} ${prev.map((p) => `v${p.label}`).join(", ")} superseded`,
      body: `Replaced by v${v.label}. Use the new release for manufacturing and site work.`,
      link: `/projects/${v.projectId}?tab=versions`,
      workspaceId: v.project.workspaceId,
    });
  }
  return { status: "RELEASED", superseded: prev.map((p) => p.label) };
}

/**
 * Signed documents are records: they are never taken back. A change to a signed (or released)
 * version is a new version, and the signed one becomes obsolete (automatically when the new
 * version is started from it, or explicitly with obsoleteVersion).
 */
const WITHDRAWABLE = ["IN_REVIEW", "APPROVED"];
const SIGNED_MSG = "A signed version cannot be taken back. Start a new version from it — this one is then marked obsolete.";

async function assertNoSignature(versionId: string) {
  const n = await db.signature.count({ where: { versionId, status: "SIGNED" } });
  if (n) throw new HttpError(409, SIGNED_MSG, "SIGNED");
}

export async function withdrawVersion(ctx: Ctx, versionId: string, reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required to withdraw a version");
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  if (["SIGNED", "RELEASED"].includes(v.status)) throw new HttpError(409, SIGNED_MSG, "SIGNED");
  if (!WITHDRAWABLE.includes(v.status)) throw new HttpError(409, `A ${v.status.toLowerCase().replace("_", " ")} version cannot be withdrawn`);
  await assertNoSignature(v.id);
  const now = new Date();
  await db.$transaction([
    db.version.update({ where: { id: v.id }, data: { status: "WITHDRAWN", endedAt: now, endReason: reason.trim() } }),
    db.review.updateMany({ where: { versionId: v.id, status: "OPEN" }, data: { status: "CANCELLED", closedAt: now } }),
    db.signature.updateMany({ where: { versionId: v.id, status: "REQUESTED" }, data: { status: "CANCELLED", declineReason: "Version withdrawn" } }),
  ]);
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "version.withdraw", data: { label: v.label, from: v.status, reason } });
  const who = await audience(v.projectId, [v.createdById]);
  await notify(who.filter((u) => u !== ctx.user.id), {
    type: "version.superseded",
    title: `${v.project.name} v${v.label} withdrawn`,
    body: reason,
    link: `/projects/${v.projectId}?tab=versions`,
    workspaceId: v.project.workspaceId,
  });
  return { status: "WITHDRAWN" };
}

export async function supersedeVersion(ctx: Ctx, versionId: string, reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required");
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  if (v.status !== "RELEASED") throw new HttpError(409, "Only released versions can be superseded");
  await db.version.update({ where: { id: v.id }, data: { status: "SUPERSEDED", endedAt: new Date(), endReason: reason.trim() } });
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "version.supersede", data: { label: v.label, reason } });
  const who = await audience(v.projectId, [v.createdById]);
  await notify(who.filter((u) => u !== ctx.user.id), { type: "version.superseded", title: `${v.project.name} v${v.label} superseded`, body: reason, link: `/projects/${v.projectId}?tab=versions`, workspaceId: v.project.workspaceId });
  return { status: "SUPERSEDED" };
}

/**
 * Take a version back from review or approval: it returns to draft and can be edited again.
 * Open or completed reviews are closed as recalled, pending signature requests are cancelled.
 * Not possible once anyone has signed it.
 */
export async function recallVersion(ctx: Ctx, versionId: string, reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required");
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  if (["SIGNED", "RELEASED"].includes(v.status)) throw new HttpError(409, SIGNED_MSG, "SIGNED");
  if (!["IN_REVIEW", "APPROVED"].includes(v.status)) throw new HttpError(409, `A ${v.status.toLowerCase().replace("_", " ")} version cannot be recalled`);
  await assertNoSignature(v.id);
  const working = await db.version.findFirst({ where: { projectId: v.projectId, variantId: v.variantId, status: { in: ["DRAFT", "CHANGES_REQUESTED"] }, id: { not: v.id } } });
  if (working) throw new HttpError(409, `Version ${working.label} is already in progress in this line — finish or withdraw it first`);
  const now = new Date();
  const reviews = await db.review.findMany({ where: { versionId: v.id, status: { in: ["OPEN", "APPROVED"] } }, include: { assignments: true } });
  const res = await db.$transaction([
    db.version.updateMany({ where: { id: v.id, status: v.status }, data: { status: "DRAFT", approvedAt: null, submittedAt: null } }),
    db.review.updateMany({ where: { id: { in: reviews.map((r) => r.id) } }, data: { status: "RECALLED", closedAt: now } }),
    db.signature.updateMany({ where: { versionId: v.id, status: "REQUESTED" }, data: { status: "CANCELLED", declineReason: "Version recalled to draft" } }),
  ]);
  if (!res[0].count) throw new HttpError(409, "The version changed meanwhile — reload and try again");
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "version.recall", data: { label: v.label, from: v.status, reason } });
  const reviewers = reviews.flatMap((r) => r.assignments.map((a) => a.userId ?? "")).filter(Boolean);
  await notify([...new Set([v.createdById, ...reviewers])].filter((u) => u !== ctx.user.id), {
    type: "version.recalled",
    title: `${v.project.name} v${v.label} was taken back${v.status === "APPROVED" ? " from approval" : " from review"}`,
    body: `${ctx.user.name}: ${reason}`,
    link: `/projects/${v.projectId}/v/${v.id}`,
    workspaceId: v.project.workspaceId,
  });
  return { status: "DRAFT" };
}

/** Mark a signed or released version obsolete (no longer valid, keep for the record). */
export async function obsoleteVersion(ctx: Ctx, versionId: string, reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required");
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  if (!["SIGNED", "RELEASED"].includes(v.status)) throw new HttpError(409, "Only signed or released versions are marked obsolete (withdraw or recall the others)");
  const now = new Date();
  await db.$transaction([
    db.version.update({ where: { id: v.id }, data: { status: "OBSOLETE", endedAt: now, endReason: reason.trim() } }),
    db.signature.updateMany({ where: { versionId: v.id, status: "REQUESTED" }, data: { status: "CANCELLED", declineReason: "Version obsolete" } }),
  ]);
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "version.obsolete", data: { label: v.label, from: v.status, reason } });
  const who = await audience(v.projectId, [v.createdById]);
  await notify(who.filter((u) => u !== ctx.user.id), { type: "version.superseded", title: `${v.project.name} v${v.label} is obsolete`, body: reason, link: `/projects/${v.projectId}?tab=versions`, workspaceId: v.project.workspaceId });
  return { status: "OBSOLETE" };
}
