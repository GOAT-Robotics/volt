import "server-only";
import { db, J, retryOnLock } from "./db";
import type { AssignmentImport, ReviewImport } from "./voltfile/types";
import { audit } from "./audit";
import { notify } from "./notify";
import { HttpError, type Ctx } from "./session";
import { parseSettings, type ApprovalPolicy } from "./settings";
import { effectivePolicy } from "./projects";
import { usersInGroup, userCan } from "./access";
import { rolesAllow, type Role } from "./roles";
import type { VersionAccess } from "./versioning";
import { computeFlow, type Flow, type FlowInput } from "./flow";
import { approvalSignature, invalidateApprovals } from "./signing/service";
import { releaseOnApproval } from "./release";

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
    if (!r) return;
    const old = await db.reviewAssignment.findMany({ where: { reviewId: r.id, decision: "APPROVED", decidedAt: { lt: cutoff } } });
    if (!old.length) return;
    await db.reviewAssignment.updateMany({ where: { id: { in: old.map((a) => a.id) } }, data: { decision: "PENDING", reason: "Approval expired", decidedAt: null, decidedById: null } });
    await invalidateApprovals({ versionId, reviewId: r.id, signatoryIds: old.map((a) => a.decidedById ?? "").filter(Boolean) }, `Approval expired after ${days} days`);
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
  if (!r0) return { review: null, canDecide: false, canApprove: false, canRecall: false, versionStatus: "", blockers: [] as string[], waiting: [] as string[] };
  const r = (await loadReview(r0.id))!;
  await primeNames(r);
  const policy = await policyForProject(r.version.project);
  const submitter = await db.user.findUnique({ where: { id: r.submittedById }, select: { name: true } });
  // waiting: what the review needs before it completes (the same for everyone);
  // blockers: why this viewer cannot decide or approve
  const waiting = r.status === "OPEN" ? await reviewBlockers(r, policy) : [];
  const blockers: string[] = [];
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
  // taking the version back to draft (never once signed)
  const st = r.version.status;
  const signed = st === "IN_REVIEW" || st === "APPROVED" ? await db.signature.count({ where: { versionId, status: "SIGNED", kind: { not: "APPROVAL" } } }) : 1;
  const manage = rolesAllow(roles, "project.manage");
  const canRecall =
    !signed &&
    ((st === "APPROVED" && (manage || rolesAllow(roles, "review.approve"))) ||
      (st === "IN_REVIEW" && (manage || (rolesAllow(roles, "project.edit") && (ctx.user.id === r.version.createdById || (r.status === "OPEN" && ctx.user.id === r.submittedById))))));
  // a review record imported from a .volt file: people and status as the file gives them
  const imp = J.parse<ReviewImport | null>(r.imported, null);
  return {
    canRecall,
    versionStatus: st,
    review: {
      id: r.id,
      status: imp?.status ?? r.status,
      importedFrom: imp?.from ?? null,
      dueDate: r.dueDate?.toISOString() ?? null,
      instructions: r.instructions,
      sequential: r.sequential,
      submittedBy: imp?.submittedBy.name ?? submitter?.name ?? "",
      assignments: r.assignments.map((a) => {
        const ai = J.parse<AssignmentImport | null>(a.imported, null);
        return {
          id: a.id,
          order: a.order,
          userName: ai ? ai.who?.name ?? null : a.userId ? names.get(a.userId) ?? null : null,
          groupName: ai ? ai.group : a.groupName,
          canApprove: a.canApprove,
          decision: a.decision,
          reason: a.reason,
          decidedAt: a.decidedAt?.toISOString() ?? null,
          decidedByName: ai ? ai.decidedBy?.name ?? null : a.decidedById ? names.get(a.decidedById) ?? null : null,
        };
      }),
    },
    canDecide,
    canApprove,
    blockers,
    waiting,
    /** approving signs: the statement the approver confirms and the name they type */
    signing: { statement: ctx.settings.signature.statement, name: ctx.user.name },
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
  // the approvals are the signatures: approved and signed at once, then released
  const res = await db.version.updateMany({ where: { id: r.versionId, status: "IN_REVIEW" }, data: { status: "APPROVED", approvedAt: now, signedAt: now } });
  if (!res.count) return r.version.status;
  await db.review.update({ where: { id: r.id }, data: { status: "APPROVED", closedAt: now } });
  const p = r.version.project;
  await audit({ workspaceId: p.workspaceId, projectId: p.id, versionId: r.versionId, actorId, type: "version.status", data: { from: "IN_REVIEW", to: "APPROVED", label: r.version.label } });
  const approvers = [...new Set(r.assignments.filter((a) => a.decision === "APPROVED" && a.canApprove).map((a) => (a.decidedById && names.get(a.decidedById)) || assigneeName(a)))];
  const note = `Approved and signed by ${approvers.length > 1 ? `${approvers.slice(0, -1).join(", ")} and ${approvers[approvers.length - 1]}` : approvers.join("")}`;
  const released = await releaseOnApproval(r.versionId, actorId, note).catch(async (e) => {
    // the approval stands; a project owner can release it from the versions list
    await notify(await stakeholders(r), { type: "review.approved", title: `${p.name} v${r.version.label} approved — release failed`, body: (e as Error).message, link: editorLink(p.id, r.versionId), workspaceId: p.workspaceId });
    return null;
  });
  return released ? "RELEASED" : "APPROVED";
}

export type Decision = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

/** approving signs: the typed full name and where the request came from (lib/access › reqMeta) */
export type ApprovalSigning = { fullName: string; ip: string | null; userAgent: string };

export async function decide(ctx: Ctx, reviewId: string, projectRoles: Role[], decision: Decision, reason: string, signing?: ApprovalSigning) {
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
  // an approval is the approver's signature: typed full name, sealed evidence over the frozen document
  let approval: Awaited<ReturnType<typeof approvalSignature>> | null = null;
  if (decision === "APPROVED") {
    if (!signing?.fullName.trim()) throw new HttpError(400, `Type your full name (“${ctx.user.name}”) to sign your approval`);
    approval = await approvalSignature(ctx, { versionId: r.versionId, reviewId: r.id, requestedById: r.submittedById, order: Math.min(...targets.map((a) => a.order)), ...signing });
  }
  const at = new Date();
  // one short batch (no transaction held open across server work): the decision and its signature
  const [u] = await retryOnLock(() =>
    db.$transaction([
      db.reviewAssignment.updateMany({ where: { id: { in: targets.map((a) => a.id) }, decision: "PENDING" }, data: { decision, reason: reason.trim() || null, decidedById: ctx.user.id, decidedAt: at } }),
      ...(approval ? [db.signature.create({ data: approval })] : []),
    ]),
  );
  if (!(u as { count: number }).count) {
    // someone decided meanwhile: the signature must not stand without its decision
    if (approval) await db.signature.deleteMany({ where: { versionId: r.versionId, kind: "APPROVAL", batch: r.id, signatoryId: ctx.user.id, signedAt: approval.signedAt } });
    throw new HttpError(409, "This review changed meanwhile — reload and try again");
  }
  const p = r.version.project;
  const base = { workspaceId: p.workspaceId, projectId: p.id, versionId: r.versionId, actorId: ctx.user.id };
  const link = editorLink(p.id, r.versionId);

  if (decision !== "APPROVED") await invalidateApprovals({ versionId: r.versionId, reviewId: r.id }, `${decision === "REJECTED" ? "Rejected" : "Changes requested"} by ${ctx.user.name}`);
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
  await audit({ ...base, type: "review.approve", data: { label: r.version.label, reason: reason || undefined, signed: true } });
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
      link: editorLink(p.id, r.versionId, "?panel=process"),
      workspaceId: p.workspaceId,
    },
  );
}

/** Starts a review for a version (status → IN_REVIEW). */
export async function startReview(
  ctx: Ctx,
  v: { id: string; projectId: string; label: string; createdById: string; status: string; project: { workspaceId: string; templateId: string | null; name: string } },
  input: { reviewers: { userId: string }[]; dueDate: Date | null; instructions: string; sequential: boolean },
) {
  const policy = await policyForProject(v.project);
  const assignments: { order: number; userId?: string; groupId?: string; groupName?: string; canApprove: boolean }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const rv of input.reviewers) {
    if (seen.has(rv.userId)) continue;
    seen.add(rv.userId);
    const member = await db.projectMember.findUnique({ where: { projectId_userId: { projectId: v.projectId, userId: rv.userId } }, include: { user: true } });
    if (!member || member.user.disabled) throw new HttpError(400, "Reviewer must be an active member of this project");
    const canDecide = await userCan(member.user.id, v.project.workspaceId, v.projectId, "review.decide");
    if (!canDecide) throw new HttpError(400, `${member.user.name} does not have a workspace Reviewer or Approver role`);
    const canApprove = await userCan(member.user.id, v.project.workspaceId, v.projectId, "review.approve");
    assignments.push({ order: order++, userId: member.user.id, canApprove });
  }
  const approvers = assignments.filter((a) => a.canApprove);
  if (!assignments.length) throw new HttpError(400, "Add at least one reviewer");
  if (approvers.length < policy.minApprovals) throw new HttpError(400, `Policy requires at least ${policy.minApprovals} project member${policy.minApprovals === 1 ? "" : "s"} with the workspace Approver role`);
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
  const head = await db.version.findUnique({ where: { id: v.id }, select: { headCommitId: true } });
  const review = await db.review.create({
    data: {
      versionId: v.id,
      commitId: head?.headCommitId ?? null,
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

/* ------------------------------------------------------------------ */
/* Next step                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the version is in draft → review → release, what it waits for and what the viewer can do
 * now (lib/flow.ts). Reading it changes nothing (apart from the lazy expiry above).
 */
export async function versionFlow(ctx: Ctx, a: VersionAccess, roles: Role[]): Promise<Flow> {
  const versionId = a.version.id;
  const info = await reviewInfo(ctx, versionId, roles);
  const v = await db.version.findUnique({ where: { id: versionId }, omit: { doc: true }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  const r = info.review && !info.review.importedFrom ? await loadReview(info.review.id) : null;
  const policy = await policyForProject(v.project);
  const openWhere = { versionId, parentId: null, status: { in: ["OPEN", "REOPENED"] } };
  const [openComments, openAiComments] = await Promise.all([db.comment.count({ where: openWhere }), db.comment.count({ where: { ...openWhere, author: { isBot: true } } })]);

  let review: FlowInput["review"] = null;
  if (r) {
    await primeNames(r);
    const me = ctx.user.id;
    const who = (x: ReviewWithAssignments["assignments"][number]) => (x.userId === me ? "you" : (x.groupName ?? assigneeName(x)));
    const mine = r.assignments.filter((x) => x.userId === me || x.decidedById === me);
    const back = r.assignments
      .filter((x) => x.decision === "CHANGES_REQUESTED" || x.decision === "REJECTED")
      .sort((p, q) => (q.decidedAt?.getTime() ?? 0) - (p.decidedAt?.getTime() ?? 0))[0];
    const approved = r.assignments.filter((x) => x.canApprove && x.decision === "APPROVED");
    review = {
      status: r.status,
      pending: r.status === "OPEN" ? r.assignments.filter((x) => x.canApprove && x.decision !== "APPROVED").map(who) : [],
      approvedBy: [...new Set(approved.map((x) => (x.decidedById === me ? "you" : (x.decidedById && names.get(x.decidedById)) || who(x))))],
      canDecide: info.canDecide,
      canApprove: info.canApprove,
      myDecision: mine.length ? (mine.find((x) => x.decision !== "PENDING")?.decision ?? "PENDING") : null,
      closedBy: back ? { name: (back.decidedById && names.get(back.decidedById)) || "a reviewer", decision: back.decision, reason: back.reason } : null,
    };
  }

  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const canEditOrManage = a.can("project.edit") || a.can("project.manage");
  return computeFlow({
    status: v.status,
    dates: { submittedAt: iso(v.submittedAt), approvedAt: iso(v.approvedAt), releasedAt: iso(v.releasedAt), endedAt: iso(v.endedAt) },
    endReason: v.endReason,
    policy: { minApprovals: policy.minApprovals, requireCommentsResolved: policy.requireCommentsResolved },
    can: {
      submit: a.editable,
      release: a.can("project.manage"),
      closeComments: canEditOrManage || v.createdById === ctx.user.id,
      newVersion: canEditOrManage && a.project.state === "ACTIVE",
      exportPdf: a.canExport,
      recall: info.canRecall,
    },
    review,
    openComments,
    openAiComments,
  });
}
