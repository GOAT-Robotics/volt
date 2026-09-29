import "server-only";
import { db } from "./db";
import { audit } from "./audit";
import { notify } from "./notify";
import { HttpError, type Ctx } from "./session";
import { parseSettings, type ApprovalPolicy } from "./settings";
import { effectivePolicy } from "./projects";
import { usersInGroup, userCan } from "./access";
import { parseRoles, rolesAllow, type Role } from "./roles";

type ReviewWithAssignments = NonNullable<Awaited<ReturnType<typeof loadReview>>>;
async function loadReview(reviewId: string) {
  return db.review.findUnique({ where: { id: reviewId }, include: { assignments: { orderBy: [{ order: "asc" }, { id: "asc" }] }, version: { omit: { doc: true }, include: { project: true } } } });
}

export const editorLink = (projectId: string, versionId: string, extra = "") => `/projects/${projectId}/v/${versionId}${extra}`;

async function policyForProject(project: { workspaceId: string; templateId: string | null }): Promise<ApprovalPolicy> {
  const ws = await db.workspace.findUnique({ where: { id: project.workspaceId } });
  return effectivePolicy(project, parseSettings(ws?.settings));
}

/* ------------------------------------------------------------------ */
/* Lazy expiry                                                          */
/* ------------------------------------------------------------------ */

/**
 * Applies time-based expiry lazily (on read):
 * - approvals older than policy.approvalExpiryDays are reset (open reviews), and APPROVED versions fall back to IN_REVIEW;
 * - signature requests past their expiry become EXPIRED.
 */
export async function applyExpiry(versionId: string): Promise<void> {
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: true } });
  if (!v) return;
  const now = new Date();
  await db.signature.updateMany({ where: { versionId, status: "REQUESTED", expiresAt: { lt: now } }, data: { status: "EXPIRED" } });
  const policy = await policyForProject(v.project);
  const days = policy.approvalExpiryDays;
  if (!days || days <= 0) return;
  const cutoff = new Date(now.getTime() - days * 86400_000);
  if (v.status === "IN_REVIEW") {
    const r = await db.review.findFirst({ where: { versionId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    if (r) await db.reviewAssignment.updateMany({ where: { reviewId: r.id, decision: "APPROVED", decidedAt: { lt: cutoff } }, data: { decision: "PENDING", reason: "Approval expired", decidedAt: null, decidedById: null } });
    return;
  }
  if (v.status === "APPROVED" && v.approvedAt && v.approvedAt < cutoff) {
    const r = await db.review.findFirst({ where: { versionId, status: "APPROVED" }, orderBy: { createdAt: "desc" } });
    await db.$transaction([
      db.version.update({ where: { id: versionId }, data: { status: "IN_REVIEW", approvedAt: null } }),
      ...(r
        ? [
            db.review.update({ where: { id: r.id }, data: { status: "OPEN", closedAt: null } }),
            db.reviewAssignment.updateMany({ where: { reviewId: r.id, decision: "APPROVED" }, data: { decision: "PENDING", reason: "Approval expired", decidedAt: null, decidedById: null } }),
          ]
        : []),
      db.signature.updateMany({ where: { versionId, status: "REQUESTED" }, data: { status: "CANCELLED", declineReason: "Approval expired" } }),
    ]);
    await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId, type: "version.status", data: { from: "APPROVED", to: "IN_REVIEW", reason: `Approval expired after ${days} days` } });
  }
}

/** applyExpiry for every version of a project, with one signature update and one policy lookup */
export async function applyProjectExpiry(projectId: string): Promise<void> {
  await db.signature.updateMany({ where: { version: { projectId }, status: "REQUESTED", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return;
  const policy = await policyForProject(project);
  if (!policy.approvalExpiryDays || policy.approvalExpiryDays <= 0) return;
  const open = await db.version.findMany({ where: { projectId, status: { in: ["IN_REVIEW", "APPROVED"] } }, select: { id: true } });
  for (const v of open) await applyExpiry(v.id);
}

/* ------------------------------------------------------------------ */
/* Review evaluation                                                    */
/* ------------------------------------------------------------------ */

function distinctApprovers(r: ReviewWithAssignments) {
  return new Set(r.assignments.filter((a) => a.decision === "APPROVED" && a.canApprove).map((a) => a.decidedById ?? a.id)).size;
}

async function openCommentCount(versionId: string) {
  return db.comment.count({ where: { versionId, parentId: null, status: { in: ["OPEN", "REOPENED"] } } });
}

/** Global blockers that prevent the review from completing (independent of the viewer). */
async function reviewBlockers(r: ReviewWithAssignments, policy: ApprovalPolicy): Promise<string[]> {
  const out: string[] = [];
  const pending = r.assignments.filter((a) => a.canApprove && a.decision !== "APPROVED");
  if (pending.length) out.push(`Waiting for ${pending.map((a) => a.groupName ?? assigneeName(a)).join(", ")}`);
  const have = distinctApprovers(r);
  if (have < policy.minApprovals) out.push(`${policy.minApprovals - have} more approval${policy.minApprovals - have === 1 ? "" : "s"} required (policy minimum ${policy.minApprovals})`);
  if (policy.requireCommentsResolved) {
    const n = await openCommentCount(r.versionId);
    if (n) out.push(`${n} open comment${n === 1 ? "" : "s"} must be resolved`);
  }
  return out;
}
const names = new Map<string, string>();
function assigneeName(a: { userId: string | null }) {
  return (a.userId && names.get(a.userId)) || "reviewer";
}
async function primeNames(r: ReviewWithAssignments) {
  const ids = r.assignments.flatMap((a) => [a.userId, a.decidedById]).filter((x): x is string => !!x);
  if (!ids.length) return;
  if (names.size > 5000) names.clear();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  for (const u of users) names.set(u.id, u.name);
}

/** Pending assignments the user is eligible for and allowed to act on now (sequential order respected). */
function eligibleAssignments(r: ReviewWithAssignments, userId: string, groups: string[]) {
  const pendingApprovers = r.assignments.filter((a) => a.canApprove && a.decision === "PENDING");
  const minOrder = pendingApprovers.length ? Math.min(...pendingApprovers.map((a) => a.order)) : Infinity;
  const mine = r.assignments.filter((a) => a.decision === "PENDING" && (a.userId === userId || (!!a.groupId && groups.includes(a.groupId))));
  const now = r.sequential ? mine.filter((a) => !a.canApprove || a.order <= minOrder) : mine;
  return { mine, now };
}

export async function reviewInfo(ctx: Ctx, versionId: string, roles: Role[]) {
  await applyExpiry(versionId);
  const r0 = await db.review.findFirst({ where: { versionId }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!r0) return { review: null, canDecide: false, canApprove: false, blockers: [] as string[] };
  const r = (await loadReview(r0.id))!;
  await primeNames(r);
  const policy = await policyForProject(r.version.project);
  const submitter = await db.user.findUnique({ where: { id: r.submittedById }, select: { name: true } });
  const blockers = r.status === "OPEN" ? await reviewBlockers(r, policy) : [];
  let canDecide = false;
  let canApprove = false;
  if (r.status === "OPEN" && r.version.status === "IN_REVIEW") {
    const { mine, now } = eligibleAssignments(r, ctx.user.id, ctx.user.groups);
    // `roles` are the effective roles from loadProject (workspace roles only count in their own workspace)
    const decide = rolesAllow(roles, "review.decide");
    const roleCanApprove = rolesAllow(roles, "review.approve");
    if (!mine.length) blockers.push("You are not assigned to this review");
    else if (!now.length) blockers.push("Sequential review — waiting for earlier reviewers");
    else if (!decide) blockers.push("Your role does not allow review decisions");
    else {
      canDecide = true;
      const self = ctx.user.id === r.version.createdById || ctx.user.id === r.submittedById;
      const approvalAssignment = now.some((a) => a.canApprove);
      if (!roleCanApprove || !approvalAssignment) blockers.push("You can request changes or reject; approving requires the Approver role");
      else if (self && !policy.allowSelfApproval) blockers.push("Workspace policy does not allow approving your own work");
      else canApprove = true;
    }
  }
  return {
    review: {
      id: r.id,
      status: r.status,
      dueDate: r.dueDate?.toISOString() ?? null,
      instructions: r.instructions,
      sequential: r.sequential,
      submittedBy: submitter?.name ?? "",
      assignments: r.assignments.map((a) => ({
        id: a.id,
        order: a.order,
        userName: a.userId ? names.get(a.userId) ?? null : null,
        groupName: a.groupName,
        canApprove: a.canApprove,
        decision: a.decision,
        reason: a.reason,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        decidedByName: a.decidedById ? names.get(a.decidedById) ?? null : null,
      })),
    },
    canDecide,
    canApprove,
    blockers,
  };
}

/** Recipients for review-related notifications: submitter + version author + project managers. */
async function stakeholders(r: ReviewWithAssignments) {
  return [r.submittedById, r.version.createdById];
}

/** Completes the review when all conditions are met. Returns the (possibly new) version status. */
export async function evaluateReview(reviewId: string, actorId: string | null): Promise<string> {
  const r = await loadReview(reviewId);
  if (!r) return "";
  if (r.status !== "OPEN" || r.version.status !== "IN_REVIEW") return r.version.status;
  await primeNames(r);
  const policy = await policyForProject(r.version.project);
  const blockers = await reviewBlockers(r, policy);
  if (blockers.length) return r.version.status;
  const now = new Date();
  const res = await db.version.updateMany({ where: { id: r.versionId, status: "IN_REVIEW" }, data: { status: "APPROVED", approvedAt: now } });
  if (!res.count) return r.version.status;
  await db.review.update({ where: { id: r.id }, data: { status: "APPROVED", closedAt: now } });
  const p = r.version.project;
  await audit({ workspaceId: p.workspaceId, projectId: p.id, versionId: r.versionId, actorId, type: "version.status", data: { from: "IN_REVIEW", to: "APPROVED", label: r.version.label } });
  await notify(await stakeholders(r), {
    type: "review.approved",
    title: `${p.name} v${r.version.label} approved`,
    body: policy.signatureRequiredForRelease ? "All approvals are in. Request signatures to release it." : "All approvals are in. It can now be released.",
    link: `/projects/${p.id}?tab=versions`,
    workspaceId: p.workspaceId,
  });
  return "APPROVED";
}

export type Decision = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

export async function decide(ctx: Ctx, reviewId: string, projectRoles: Role[], decision: Decision, reason: string) {
  await (async () => {
    const r = await db.review.findUnique({ where: { id: reviewId }, select: { versionId: true } });
    if (r) await applyExpiry(r.versionId);
  })();
  const r = await loadReview(reviewId);
  if (!r) throw new HttpError(404, "Review not found");
  if (r.status !== "OPEN" || r.version.status !== "IN_REVIEW") throw new HttpError(409, "This review is closed");
  const roles = projectRoles; // effective roles from loadProject
  if (!rolesAllow(roles, "review.decide")) throw new HttpError(403, "Your role does not allow review decisions");
  if (decision === "APPROVED" && !rolesAllow(roles, "review.approve")) throw new HttpError(403, "Approving requires the Approver role");
  if (decision !== "APPROVED" && !reason.trim()) throw new HttpError(400, "A reason is required");
  const policy = await policyForProject(r.version.project);
  if (decision === "APPROVED" && !policy.allowSelfApproval && (ctx.user.id === r.version.createdById || ctx.user.id === r.submittedById)) {
    throw new HttpError(403, "Workspace policy does not allow approving your own work");
  }
  const { mine, now } = eligibleAssignments(r, ctx.user.id, ctx.user.groups);
  if (!mine.length) throw new HttpError(403, "You are not assigned to this review");
  if (!now.length) throw new HttpError(409, "Sequential review — earlier reviewers must decide first");
  let targets = now;
  if (decision === "APPROVED") {
    targets = now.filter((a) => a.canApprove);
    if (!targets.length) throw new HttpError(403, "Your assignment is advisory — you can request changes or reject");
    if (r.sequential) {
      const o = Math.min(...targets.map((a) => a.order));
      targets = targets.filter((a) => a.order === o);
    }
  }
  const at = new Date();
  await db.reviewAssignment.updateMany({ where: { id: { in: targets.map((a) => a.id) }, decision: "PENDING" }, data: { decision, reason: reason.trim() || null, decidedById: ctx.user.id, decidedAt: at } });
  const p = r.version.project;
  const base = { workspaceId: p.workspaceId, projectId: p.id, versionId: r.versionId, actorId: ctx.user.id };
  const link = editorLink(p.id, r.versionId);

  if (decision === "REJECTED") {
    await db.$transaction([
      db.review.update({ where: { id: r.id }, data: { status: "REJECTED", closedAt: at } }),
      db.version.update({ where: { id: r.versionId }, data: { status: "REJECTED", endedAt: at, endReason: reason.trim() } }),
    ]);
    await audit({ ...base, type: "review.reject", data: { label: r.version.label, reason } });
    await notify(await stakeholders(r), { type: "review.rejected", title: `${p.name} v${r.version.label} was rejected`, body: `${ctx.user.name}: ${reason}`, link, workspaceId: p.workspaceId });
    return { versionStatus: "REJECTED" };
  }
  if (decision === "CHANGES_REQUESTED") {
    await db.$transaction([
      db.review.update({ where: { id: r.id }, data: { status: "CHANGES_REQUESTED", closedAt: at } }),
      db.version.update({ where: { id: r.versionId }, data: { status: "CHANGES_REQUESTED" } }),
    ]);
    await audit({ ...base, type: "review.changes", data: { label: r.version.label, reason } });
    await notify(await stakeholders(r), { type: "review.changes", title: `Changes requested on ${p.name} v${r.version.label}`, body: `${ctx.user.name}: ${reason}`, link, workspaceId: p.workspaceId });
    return { versionStatus: "CHANGES_REQUESTED" };
  }
  await audit({ ...base, type: "review.approve", data: { label: r.version.label, reason: reason || undefined } });
  const status = await evaluateReview(r.id, ctx.user.id);
  if (status === "IN_REVIEW" && r.sequential) await notifyNextInOrder(r.id);
  return { versionStatus: status };
}

/** Notify the assignees that are now actionable (sequential reviews). */
export async function notifyNextInOrder(reviewId: string) {
  const r = await loadReview(reviewId);
  if (!r || r.status !== "OPEN") return;
  const pend = r.assignments.filter((a) => a.canApprove && a.decision === "PENDING");
  if (!pend.length) return;
  const o = Math.min(...pend.map((a) => a.order));
  await notifyAssignees(r, pend.filter((a) => a.order === o));
}

export async function notifyAssignees(r: ReviewWithAssignments, list: ReviewWithAssignments["assignments"]) {
  const ids: string[] = [];
  for (const a of list) {
    if (a.userId) ids.push(a.userId);
    else if (a.groupId) ids.push(...(await usersInGroup(a.groupId)));
  }
  const p = r.version.project;
  await notify(
    ids.filter((i) => i !== r.submittedById),
    {
      type: "review.assigned",
      title: `Review requested: ${p.name} v${r.version.label}`,
      body: r.dueDate ? `Due ${r.dueDate.toISOString().slice(0, 10)}. ${r.instructions}` : r.instructions,
      link: editorLink(p.id, r.versionId),
      workspaceId: p.workspaceId,
    },
  );
}

/** Starts a review for a version (status → IN_REVIEW). */
export async function startReview(
  ctx: Ctx,
  v: { id: string; projectId: string; label: string; createdById: string; status: string; project: { workspaceId: string; templateId: string | null; name: string } },
  input: { reviewers: ({ userId: string } | { groupId: string; groupName?: string })[]; dueDate: Date | null; instructions: string; sequential: boolean },
) {
  const policy = await policyForProject(v.project);
  const assignments: { order: number; userId?: string; groupId?: string; groupName?: string; canApprove: boolean }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const rv of input.reviewers) {
    if ("userId" in rv) {
      if (seen.has(rv.userId)) continue;
      seen.add(rv.userId);
      const u = await db.user.findUnique({ where: { id: rv.userId } });
      if (!u || u.disabled) throw new HttpError(400, "Unknown or disabled reviewer");
      const canDecide = await userCan(u.id, v.project.workspaceId, v.projectId, "review.decide");
      if (!canDecide) throw new HttpError(400, `${u.name} does not have a reviewer or approver role`);
      const canApprove = await userCan(u.id, v.project.workspaceId, v.projectId, "review.approve");
      assignments.push({ order: order++, userId: u.id, canApprove });
    } else {
      if (seen.has(rv.groupId)) continue;
      seen.add(rv.groupId);
      // only Entra groups mapped in this workspace; they approve when their mapped roles allow it
      const gm = await db.groupMapping.findFirst({ where: { workspaceId: v.project.workspaceId, entraGroupId: rv.groupId } });
      if (!gm) throw new HttpError(400, `Group ${rv.groupName ?? rv.groupId} is not set up in this workspace (Administration → Groups)`);
      if (!rolesAllow(parseRoles(gm.roles), "review.decide")) throw new HttpError(400, `Group ${gm.displayName || rv.groupId} does not have a reviewer or approver role`);
      assignments.push({ order: order++, groupId: rv.groupId, groupName: gm.displayName || rv.groupName || rv.groupId, canApprove: rolesAllow(parseRoles(gm.roles), "review.approve") });
    }
  }
  const approvers = assignments.filter((a) => a.canApprove);
  if (!assignments.length) throw new HttpError(400, "Add at least one reviewer");
  if (approvers.length < policy.minApprovals) throw new HttpError(400, `Policy requires at least ${policy.minApprovals} approver${policy.minApprovals === 1 ? "" : "s"} (users with the Approver role or Entra groups)`);
  if (!policy.allowSelfApproval) {
    const eligibleApprovers = approvers.filter((a) => a.groupId || (a.userId !== ctx.user.id && a.userId !== v.createdById));
    if (eligibleApprovers.length < policy.minApprovals) {
      throw new HttpError(400, `Policy requires ${policy.minApprovals} eligible approver${policy.minApprovals === 1 ? "" : "s"}; authors and submitters do not count when self-approval is disabled`);
    }
  }
  const now = new Date();
  const res = await db.version.updateMany({ where: { id: v.id, status: { in: ["DRAFT", "CHANGES_REQUESTED"] } }, data: { status: "IN_REVIEW", submittedAt: now } });
  if (!res.count) throw new HttpError(409, "This version can no longer be submitted");
  await db.review.updateMany({ where: { versionId: v.id, status: "OPEN" }, data: { status: "CANCELLED", closedAt: now } });
  const review = await db.review.create({
    data: {
      versionId: v.id,
      submittedById: ctx.user.id,
      instructions: input.instructions,
      dueDate: input.dueDate,
      sequential: input.sequential,
      assignments: { create: assignments },
    },
  });
  const full = (await loadReview(review.id))!;
  if (input.sequential) {
    const first = full.assignments.filter((a) => a.canApprove);
    const o = first.length ? first[0].order : 0;
    await notifyAssignees(full, full.assignments.filter((a) => !a.canApprove || a.order === o));
  } else await notifyAssignees(full, full.assignments);
  return review;
}
