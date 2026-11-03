import "server-only";
import { randomUUID } from "node:crypto";
import { db, J } from "../db";
import { audit } from "../audit";
import { day, notify, projectLabel, rows, versionLabel, when } from "../notify";
import { HttpError, type Ctx } from "../session";
import { parseSettings } from "../settings";
import { parseDoc, docHash } from "../versioning";
import { userCan, projectManagers } from "../access";
import { effectivePolicy } from "../projects";
import { versionHashes } from "./canonical";
import { getProvider, type SignatureEvidence } from "./provider";
import { loadKeys } from "./builtin";
import { parseRoles } from "../roles";

export const SIGNABLE_STATUSES = ["APPROVED"];
export const IMMUTABLE_SIGNED = ["APPROVED", "SIGNED", "RELEASED", "SUPERSEDED"];
/** what an approval signature is for (Signature.kind APPROVAL) */
export const APPROVAL_PURPOSE = "Approval for release";

const normName = (x: string) => x.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * An approval is the approver's electronic signature. Checks the typed full name, hashes the
 * frozen document and its canonical PDF, and seals the evidence like any signature. Returns the
 * Signature row to write together with the decision (lib/workflow › decide).
 */
export async function approvalSignature(ctx: Ctx, input: { versionId: string; reviewId: string; requestedById: string; order: number; fullName: string; ip: string | null; userAgent: string }) {
  if (normName(input.fullName) !== normName(ctx.user.name)) throw new HttpError(400, `Type your full name exactly as “${ctx.user.name}” to sign your approval`);
  const v = await db.version.findUnique({ where: { id: input.versionId }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  const h = await versionHashes(parseDoc(v.doc), v.label);
  if (v.docHash && v.docHash !== h.docHash) throw new HttpError(409, "Document hash mismatch — the version changed after it was submitted. Approval refused.");
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  const ws = await db.workspace.findUnique({ where: { id: v.project.workspaceId } });
  const settings = parseSettings(ws?.settings);
  const provider = await getProvider("builtin");
  const signedAt = new Date();
  const evidence: SignatureEvidence = {
    signatory: { id: user.id, name: user.name, email: user.email, entraOid: user.entraOid },
    authTime: ctx.authTime,
    signedAt: signedAt.toISOString(),
    ip: input.ip,
    userAgent: input.userAgent.slice(0, 400),
    versionId: v.id,
    label: v.label,
    projectId: v.projectId,
    docHash: h.docHash,
    pdfHash: h.pdfHash,
    purpose: APPROVAL_PURPOSE,
    statement: settings.signature.statement,
    provider: provider.id,
    keyId: provider.id === "builtin" ? loadKeys().keyId : undefined,
  };
  const { seal, providerRef } = await provider.complete({ signatureId: `approval:${input.reviewId}:${user.id}`, providerRef: null, evidence });
  return {
    versionId: v.id,
    kind: "APPROVAL",
    signatoryId: user.id,
    requestedById: input.requestedById,
    purpose: APPROVAL_PURPOSE,
    order: input.order,
    status: "SIGNED",
    docHash: h.docHash,
    pdfHash: h.pdfHash,
    provider: provider.id,
    providerRef: providerRef ?? null,
    evidence: JSON.stringify(evidence),
    seal,
    signedAt,
    batch: input.reviewId,
  };
}

/** Approval signatures of a review stop counting (recalled, changes requested, rejected, expired). */
export async function invalidateApprovals(where: { versionId: string; reviewId?: string; signatoryIds?: string[] }, reason: string) {
  await db.signature.updateMany({
    where: { versionId: where.versionId, kind: "APPROVAL", status: "SIGNED", ...(where.reviewId ? { batch: where.reviewId } : {}), ...(where.signatoryIds ? { signatoryId: { in: where.signatoryIds } } : {}) },
    data: { status: "INVALIDATED", declineReason: reason },
  });
}

/** Project members eligible to sign through their workspace Approver (formerly Signatory) or Admin role. */
export async function eligibleSignatories(workspaceId: string, projectId: string) {
  const pms = await db.projectMember.findMany({ where: { projectId }, select: { userId: true } });
  const mems = await db.membership.findMany({ where: { workspaceId, userId: { in: pms.map((m) => m.userId) } }, include: { user: true } });
  const out: { id: string; name: string; email: string }[] = [];
  for (const m of mems) {
    if (m.user.disabled) continue;
    const r = parseRoles(m.roles);
    if (r.includes("APPROVER") || r.includes("ADMIN")) out.push({ id: m.user.id, name: m.user.name, email: m.user.email });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function requestSignatures(ctx: Ctx, versionId: string, input: { signatoryIds: string[]; purpose: string; baseUrl: string }) {
  const v = await db.version.findUnique({ where: { id: versionId }, include: { project: true } });
  if (!v) throw new HttpError(404, "Version not found");
  if (!SIGNABLE_STATUSES.includes(v.status)) throw new HttpError(409, "Signatures can be requested only for approved versions");
  const ws = await db.workspace.findUnique({ where: { id: v.project.workspaceId } });
  const settings = parseSettings(ws?.settings);
  const policy = await effectivePolicy(v.project, settings);
  const ids = [...new Set(input.signatoryIds)];
  if (ids.length < Math.max(1, policy.requiredSignatories)) throw new HttpError(400, `Select at least ${Math.max(1, policy.requiredSignatories)} signator${policy.requiredSignatories === 1 ? "y" : "ies"}`);
  const eligible = new Set((await eligibleSignatories(v.project.workspaceId, v.projectId)).map((u) => u.id));
  for (const id of ids) if (!eligible.has(id)) throw new HttpError(400, "Only users with the Signatory or Admin role can sign");
  const doc = parseDoc(v.doc);
  const h = await versionHashes(doc, v.label);
  if (v.docHash && v.docHash !== h.docHash) throw new HttpError(409, "Stored document hash does not match — the version is not intact");
  const provider = await getProvider(settings.signature.provider);
  const expiresAt = settings.signature.expiryDays > 0 ? new Date(Date.now() + settings.signature.expiryDays * 86400_000) : null;
  await db.signature.updateMany({ where: { versionId, status: "REQUESTED" }, data: { status: "CANCELLED", declineReason: "Superseded by a new request" } });
  const users = await db.user.findMany({ where: { id: { in: ids } } });
  const created = [];
  const batch = randomUUID();
  for (const [order, uid] of ids.entries()) {
    const u = users.find((x) => x.id === uid)!;
    const s = await db.signature.create({
      data: { versionId, signatoryId: uid, requestedById: ctx.user.id, purpose: input.purpose, order, status: "REQUESTED", batch, expiresAt, docHash: h.docHash, pdfHash: h.pdfHash, provider: provider.id },
    });
    const r = await provider.request({
      signatureId: s.id,
      signatory: { id: u.id, name: u.name, email: u.email, entraOid: u.entraOid },
      projectName: v.project.name,
      label: v.label,
      purpose: input.purpose,
      docHash: h.docHash,
      pdfHash: h.pdfHash,
      expiresAt,
      returnUrl: `${input.baseUrl}/sign/${s.id}`,
    });
    if (r.providerRef) await db.signature.update({ where: { id: s.id }, data: { providerRef: r.providerRef } });
    created.push(s);
  }
  if (!v.docHash) await db.version.update({ where: { id: versionId }, data: { docHash: h.docHash } });
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId, actorId: ctx.user.id, type: "signature.request", data: { label: v.label, purpose: input.purpose, signatories: users.map((u) => u.name) } });
  // sequential: only the first signatory is actionable now
  await notifySignatory(created[0].id);
  return created.map((s) => s.id);
}

async function notifySignatory(signatureId: string) {
  const s = await db.signature.findUnique({ where: { id: signatureId }, include: { version: { omit: { doc: true }, include: { project: true } } } });
  if (!s || s.status !== "REQUESTED") return;
  const by = await db.user.findUnique({ where: { id: s.requestedById }, select: { name: true } });
  const round = s.batch ? await db.signature.findMany({ where: { versionId: s.versionId, batch: s.batch }, select: { order: true, signatoryId: true, status: true } }) : [];
  const others = round.length > 1 ? await db.user.findMany({ where: { id: { in: round.map((x) => x.signatoryId) } }, select: { id: true, name: true } }) : [];
  const name = (id: string) => others.find((u) => u.id === id)?.name ?? "?";
  await notify([s.signatoryId], {
    type: "signature.requested",
    title: `Signature requested: ${s.version.project.name} v${s.version.label}`,
    body: s.purpose,
    details: rows(
      ["Project", projectLabel(s.version.project)],
      ["Version", versionLabel(s.version)],
      by && ["Requested by", by.name],
      ["Requested on", when(s.createdAt)],
      s.expiresAt && ["Sign by", day(s.expiresAt)],
      round.length > 1 && ["Signing order", `${s.order + 1} of ${round.length}: ${[...round].sort((a, b) => a.order - b.order).map((x) => `${name(x.signatoryId)}${x.status === "SIGNED" ? " ✓" : ""}`).join(" → ")}`],
      ["Document", `frozen at hash ${s.docHash.slice(0, 12)}… — what you sign is what was reviewed`],
    ),
    link: `/sign/${s.id}`,
    action: "Review and sign",
    links: [{ label: "Open the drawing in Volt", href: `/projects/${s.version.projectId}/v/${s.versionId}` }],
    workspaceId: s.version.project.workspaceId,
  });
}

/** Loads a signature for the signatory, applying lazy expiry. */
export async function loadSignature(signatureId: string) {
  await db.signature.updateMany({ where: { id: signatureId, status: "REQUESTED", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
  const s = await db.signature.findUnique({ where: { id: signatureId }, include: { version: { include: { project: true } } } });
  if (!s) throw new HttpError(404, "Signature not found");
  return s;
}

/** Why the signatory cannot sign right now (null if they can). */
export async function signBlocker(s: Awaited<ReturnType<typeof loadSignature>>, ctx: Ctx): Promise<string | null> {
  if (s.signatoryId !== ctx.user.id) return "This signature was requested from another person.";
  if (s.status !== "REQUESTED") return `This signature request is ${s.status.toLowerCase()}.`;
  if (s.version.status !== "APPROVED") return `The version is ${s.version.status.toLowerCase().replace("_", " ")} — signing is only possible while it is approved.`;
  const earlier = await db.signature.count({ where: { versionId: s.versionId, status: "REQUESTED", order: { lt: s.order } } });
  if (earlier) return "Waiting for earlier signatories (sequential signing).";
  if (!(await userCan(ctx.user.id, s.version.project.workspaceId, s.version.projectId, "sign"))) return "Your role no longer allows signing.";
  return null;
}

export function reauthOk(ctx: Ctx) {
  const mins = ctx.settings.signReauthMinutes;
  return !!ctx.authTime && Date.now() - ctx.authTime <= mins * 60_000;
}

export async function signSignature(ctx: Ctx, signatureId: string, input: { fullName: string; ip: string | null; userAgent: string }) {
  const s = await loadSignature(signatureId);
  const block = await signBlocker(s, ctx);
  if (block) throw new HttpError(409, block);
  if (!reauthOk(ctx)) throw new HttpError(401, `Please re-authenticate (sign-in must be within the last ${ctx.settings.signReauthMinutes} minutes)`, "REAUTH");
  const norm = (x: string) => x.trim().replace(/\s+/g, " ").toLowerCase();
  if (norm(input.fullName) !== norm(ctx.user.name)) throw new HttpError(400, `Type your full name exactly as “${ctx.user.name}” to confirm`);
  const v = s.version;
  const doc = parseDoc(v.doc);
  const h = await versionHashes(doc, v.label);
  if (h.docHash !== s.docHash || (v.docHash && v.docHash !== h.docHash)) throw new HttpError(409, "Document hash mismatch — the version changed since the request. Signing refused.");
  if (h.pdfHash !== s.pdfHash) throw new HttpError(409, "PDF hash mismatch — the rendered drawing differs from the requested one. Signing refused.");
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  const ws = await db.workspace.findUnique({ where: { id: v.project.workspaceId } });
  const settings = parseSettings(ws?.settings);
  const provider = await getProvider(s.provider);
  const signedAt = new Date();
  const evidence: SignatureEvidence = {
    signatory: { id: user.id, name: user.name, email: user.email, entraOid: user.entraOid },
    authTime: ctx.authTime,
    signedAt: signedAt.toISOString(),
    ip: input.ip,
    userAgent: input.userAgent.slice(0, 400),
    versionId: v.id,
    label: v.label,
    projectId: v.projectId,
    docHash: h.docHash,
    pdfHash: h.pdfHash,
    purpose: s.purpose,
    statement: settings.signature.statement,
    provider: provider.id,
    keyId: provider.id === "builtin" ? loadKeys().keyId : undefined,
  };
  const { seal, providerRef } = await provider.complete({ signatureId: s.id, providerRef: s.providerRef, evidence });
  const res = await db.signature.updateMany({
    where: { id: s.id, status: "REQUESTED" },
    data: { status: "SIGNED", signedAt, evidence: JSON.stringify(evidence), seal, providerRef: providerRef ?? s.providerRef },
  });
  if (!res.count) throw new HttpError(409, "This signature request changed — reload and try again");
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "signature.sign", data: { label: v.label, purpose: s.purpose, signatureId: s.id } });
  // complete?
  const round = await db.signature.findMany({ where: { versionId: v.id, batch: s.batch } });
  const pending = round.filter((x) => x.status !== "SIGNED");
  if (!pending.length) {
    const done = await db.version.updateMany({ where: { id: v.id, status: "APPROVED" }, data: { status: "SIGNED", signedAt } });
    if (done.count) {
      await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "version.status", data: { from: "APPROVED", to: "SIGNED", label: v.label } });
      const mgr = await projectManagers(v.projectId, v.project.workspaceId);
      const signers = await db.user.findMany({ where: { id: { in: round.map((x) => x.signatoryId) } }, select: { id: true, name: true } });
      await notify([s.requestedById, v.createdById, ...mgr], {
        type: "version.released",
        title: `${v.project.name} v${v.label} is fully signed`,
        body: "All requested signatures are complete. Next: release it.",
        details: rows(
          ["Project", projectLabel(v.project)],
          ["Version", versionLabel(v)],
          ["Purpose", s.purpose],
          ["Signed by", [...round].sort((a, b) => a.order - b.order).map((x) => signers.find((u) => u.id === x.signatoryId)?.name ?? "?").join(", ")],
          ["Completed on", when(signedAt)],
          ["What now", "A project owner releases the version from the versions list; the release PDF carries the signatures."],
        ),
        link: `/projects/${v.projectId}/v/${v.id}`,
        action: "Open the version",
        links: [{ label: "See the versions", href: `/projects/${v.projectId}?tab=versions` }],
        workspaceId: v.project.workspaceId,
      });
    }
  } else {
    const next = pending.filter((x) => x.status === "REQUESTED").sort((a, b) => a.order - b.order)[0];
    if (next) await notifySignatory(next.id);
  }
  return { ok: true, versionStatus: pending.length ? v.status : "SIGNED" };
}

export async function declineSignature(ctx: Ctx, signatureId: string, reason: string) {
  const s = await loadSignature(signatureId);
  if (s.signatoryId !== ctx.user.id) throw new HttpError(403, "This signature was requested from another person");
  if (s.status !== "REQUESTED") throw new HttpError(409, `This request is ${s.status.toLowerCase()}`);
  if (!reason.trim()) throw new HttpError(400, "A reason is required");
  await db.$transaction([
    db.signature.update({ where: { id: s.id }, data: { status: "DECLINED", declineReason: reason.trim() } }),
    db.signature.updateMany({ where: { versionId: s.versionId, status: "REQUESTED", id: { not: s.id } }, data: { status: "CANCELLED", declineReason: `Cancelled: ${ctx.user.name} declined` } }),
  ]);
  const v = s.version;
  await audit({ workspaceId: v.project.workspaceId, projectId: v.projectId, versionId: v.id, actorId: ctx.user.id, type: "signature.decline", data: { label: v.label, reason } });
  await notify([s.requestedById, v.createdById], {
    type: "signature.requested",
    title: `${ctx.user.name} declined to sign ${v.project.name} v${v.label}`,
    body: `${ctx.user.name}: ${reason.trim()}`,
    details: rows(
      ["Project", projectLabel(v.project)],
      ["Version", versionLabel(v)],
      ["Purpose", s.purpose],
      ["Declined by", ctx.user.name],
      ["On", when(new Date())],
      ["What now", "The other pending requests of this round were cancelled. Address the reason, then request the signatures again."],
    ),
    link: `/projects/${v.projectId}?tab=signatures`,
    action: "See the signatures",
    links: [{ label: "Open the version", href: `/projects/${v.projectId}/v/${v.id}` }],
    workspaceId: v.project.workspaceId,
  });
}

export type Check = { name: string; ok: boolean; detail: string };

export async function verifySignature(signatureId: string): Promise<{ valid: boolean; checks: Check[]; signature: { id: string; status: string; signedAt: string | null; signatory: string | null; label: string; projectId: string } }> {
  const s = await db.signature.findUnique({ where: { id: signatureId }, include: { version: { include: { project: true } } } });
  if (!s) throw new HttpError(404, "Signature not found");
  const checks: Check[] = [];
  const ev = J.parse<SignatureEvidence | null>(s.evidence, null);
  checks.push({ name: "Signed", ok: s.status === "SIGNED" && !!ev && !!s.seal, detail: s.status === "SIGNED" ? `Signed ${s.signedAt?.toISOString()}` : `Status is ${s.status}` });
  if (ev && s.seal) {
    const provider = await getProvider(s.provider);
    const r = await provider.verify({ evidence: ev, seal: s.seal, providerRef: s.providerRef });
    checks.push({ name: "Seal", ok: r.valid, detail: r.detail });
    checks.push({ name: "Evidence binding", ok: ev.versionId === s.versionId && ev.signatory.id === s.signatoryId && ev.docHash === s.docHash && ev.pdfHash === s.pdfHash, detail: "Evidence refers to this version, signatory and hashes" });
    const doc = parseDoc(s.version.doc);
    const dh = docHash(doc);
    checks.push({ name: "Document hash", ok: dh === ev.docHash, detail: dh === ev.docHash ? `sha256 ${dh}` : `Stored document hashes to ${dh}, evidence has ${ev.docHash}` });
    const { pdfHash } = await versionHashes(doc, s.version.label);
    checks.push({ name: "Drawing PDF hash", ok: pdfHash === ev.pdfHash, detail: pdfHash === ev.pdfHash ? `sha256 ${pdfHash}` : `Canonical PDF now hashes to ${pdfHash}` });
  }
  // an approval signature is given while the version is frozen for review
  const immutable = IMMUTABLE_SIGNED.includes(s.version.status) || (s.kind === "APPROVAL" && s.version.status === "IN_REVIEW");
  checks.push({ name: "Version immutable", ok: immutable, detail: immutable ? `Version is ${s.version.status.toLowerCase()}` : `Version is ${s.version.status.toLowerCase().replace("_", " ")}` });
  return {
    valid: checks.every((c) => c.ok),
    checks,
    signature: { id: s.id, status: s.status, signedAt: s.signedAt?.toISOString() ?? null, signatory: ev?.signatory.name ?? null, label: s.version.label, projectId: s.version.projectId },
  };
}
