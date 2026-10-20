/**
 * Export a project (or one version) as a sealed .volt file. See ./format.ts and docs/VOLT_FORMAT.md.
 */
import "server-only";
import { db } from "../db";
import type { Ctx } from "../session";
import { docHash, parseDoc } from "../versioning";
import { unpackDoc } from "../commits";
import { flushLive } from "../live/hooks";
import { loadKeys } from "../signing/builtin";
import type { Doc } from "@/core/model";
import { packVolt, type Person, type VoltBundle, type VoltComment, type VoltFile, type VoltHeader, type VoltReview, type VoltSignature, type VoltVersion, type VoltCommit, VOLT_EXTENSION } from "./format";
import { jsonOr, type AssignmentImport, type ExternalAuthor, type ExternalPerson, type ReviewImport, type VersionImport } from "./types";

export type ExportOptions = { reviews: boolean; history: boolean; files: boolean };

/** ?reviews=0&history=0&files=0 switch parts off (all on by default) */
export function exportOptions(url: URL): ExportOptions {
  const on = (k: string) => !["0", "false", "no"].includes(url.searchParams.get(k) ?? "");
  return { reviews: on("reviews"), history: on("history"), files: on("files") };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ext = (p: ExternalPerson | null | undefined): Person | null => (p ? { id: "", name: p.name, ...(p.email ? { email: p.email } : {}), ...(p.bot ? { bot: true } : {}) } : null);

/** the name this server goes by in files it exports */
export function serverName(ctx: Ctx) {
  return ctx.settings.branding.name?.trim() || ctx.workspace.name || "Volt";
}
export function serverUrl() {
  return (process.env.APP_URL || process.env.AUTH_URL || "").replace(/\/$/, "") || null;
}

export function voltFilename(project: { name: string; number: string | null }, versionLabel?: string) {
  const base = `${(project.number ? project.number + "_" : "") + project.name}`.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
  return `${base}${versionLabel ? `_v${versionLabel.replace(/[^\w.-]+/g, "_")}` : ""}${VOLT_EXTENSION}`;
}

/**
 * Collect everything and pack it. `canManage`: signature evidence (signer IP, user agent, account
 * ids) is included only for people who may see it in the project (project managers).
 */
export async function exportVolt(ctx: Ctx, input: { projectId: string; versionId?: string; options: ExportOptions; canManage: boolean }) {
  const project = await db.project.findUniqueOrThrow({ where: { id: input.projectId } });
  const scope: "project" | "version" = input.versionId ? "version" : "project";
  const options: ExportOptions = { ...input.options, history: scope === "project" && input.options.history };

  // working versions may have live changes that are not saved yet
  const ids = await db.version.findMany({ where: scope === "version" ? { id: input.versionId, projectId: project.id } : { projectId: project.id }, select: { id: true, status: true }, orderBy: { seq: "asc" } });
  for (const v of ids) if (["DRAFT", "CHANGES_REQUESTED"].includes(v.status)) await flushLive(v.id);
  const rows = await db.version.findMany({ where: { id: { in: ids.map((v) => v.id) } }, orderBy: { seq: "asc" } });
  const versionIds = new Set(rows.map((v) => v.id));

  const variants = await db.variant.findMany({ where: scope === "project" ? { projectId: project.id } : { id: { in: rows.map((v) => v.variantId).filter((x): x is string => !!x) } }, orderBy: { createdAt: "asc" } });
  const comments = options.reviews ? await db.comment.findMany({ where: { projectId: project.id, versionId: { in: [...versionIds] } }, orderBy: { createdAt: "asc" } }) : [];
  const reviews = options.reviews ? await db.review.findMany({ where: { versionId: { in: [...versionIds] } }, include: { assignments: { orderBy: [{ order: "asc" }, { id: "asc" }] } }, orderBy: { createdAt: "asc" } }) : [];
  const signatures = options.reviews ? await db.signature.findMany({ where: { versionId: { in: [...versionIds] } }, orderBy: [{ createdAt: "asc" }, { order: "asc" }] }) : [];
  const commits = options.history ? await db.commit.findMany({ where: { projectId: project.id }, orderBy: { seq: "asc" } }) : [];

  // people
  const uids = new Set<string>([ctx.user.id, project.createdById]);
  rows.forEach((v) => uids.add(v.createdById));
  variants.forEach((v) => uids.add(v.createdById));
  comments.forEach((c) => uids.add(c.authorId));
  reviews.forEach((r) => (uids.add(r.submittedById), r.assignments.forEach((a) => [a.userId, a.decidedById].forEach((x) => x && uids.add(x)))));
  signatures.forEach((s) => uids.add(s.signatoryId));
  commits.forEach((c) => uids.add(c.authorId));
  const users = new Map((await db.user.findMany({ where: { id: { in: [...uids] } }, select: { id: true, name: true, email: true, isBot: true } })).map((u) => [u.id, u]));
  const person = (id: string | null | undefined): Person => {
    const u = id ? users.get(id) : undefined;
    return u ? { id: u.id, name: u.name, email: u.email, ...(u.isBot ? { bot: true } : {}) } : { id: id ?? "", name: "Unknown" };
  };

  // versions + drawings
  const drawings = new Map<string, Doc>();
  const versions: VoltVersion[] = [];
  const carriedSignatures: VoltSignature[] = [];
  for (const v of rows) {
    const doc = parseDoc(v.doc);
    drawings.set(v.id, doc);
    const imp = jsonOr<VersionImport | null>(v.imported, null);
    const record = v.status === "IMPORTED" && imp;
    versions.push({
      id: v.id,
      seq: v.seq,
      label: v.label,
      status: record ? imp.status : v.status,
      statusFrom: record ? imp.statusFrom || imp.server : null,
      variantId: v.variantId,
      parentId: v.parentId && versionIds.has(v.parentId) ? v.parentId : null,
      summary: v.summary,
      description: v.description,
      ticket: v.ticket,
      createdBy: (imp?.createdBy && ext(imp.createdBy)) || person(v.createdById),
      createdAt: iso(v.createdAt),
      submittedAt: iso(v.submittedAt),
      approvedAt: iso(v.approvedAt),
      signedAt: iso(v.signedAt),
      releasedAt: iso(v.releasedAt),
      endedAt: iso(v.endedAt),
      endReason: v.endReason,
      docHash: docHash(doc),
      headCommitId: options.history ? v.headCommitId : null,
      baseCommitId: options.history ? v.baseCommitId : null,
      lineage: imp?.keys ?? [],
    });
    // signature records that came with an imported version travel on
    if (options.reviews && imp?.signatures?.length)
      imp.signatures.forEach((s, i) =>
        carriedSignatures.push({
          id: `${v.id}-imported-${i}`,
          versionId: v.id,
          signatory: ext(s.signatory)!,
          purpose: s.purpose,
          order: s.order,
          status: s.status,
          docHash: s.docHash,
          pdfHash: s.pdfHash,
          provider: s.provider,
          signedAt: s.signedAt,
          declineReason: s.declineReason,
          createdAt: null,
          evidence: input.canManage ? s.evidence : null,
          seal: input.canManage ? s.seal : null,
          importedFrom: { server: s.server, sealValid: s.sealValid },
        }),
      );
  }

  const history = new Map<string, Doc>();
  const voltCommits: VoltCommit[] = [];
  for (const c of commits) {
    if (!versionIds.has(c.versionId)) continue;
    history.set(c.id, unpackDoc(c.data));
    const ea = jsonOr<ExternalPerson | null>(c.externalAuthor, null);
    voltCommits.push({ id: c.id, versionId: c.versionId, parentId: c.parentId, seq: c.seq, kind: c.kind, message: c.message, docHash: c.docHash, author: ext(ea) ?? person(c.authorId), createdAt: iso(c.createdAt) });
  }

  const voltComments: VoltComment[] = comments.map((c) => {
    const ea = jsonOr<ExternalAuthor | null>(c.externalAuthor, null);
    return {
      id: c.id,
      versionId: c.versionId,
      pageId: c.pageId,
      anchor: jsonOr(c.anchor, null),
      parentId: c.parentId,
      body: c.body,
      status: c.status,
      author: ext(ea) ?? person(c.authorId),
      createdAt: iso(c.createdAt),
      updatedAt: iso(c.updatedAt),
      lineage: (c.origin ?? "").split(" ").filter(Boolean),
      from: ea?.server ?? null,
    };
  });

  const voltReviews: VoltReview[] = reviews.map((r) => {
    const imp = jsonOr<ReviewImport | null>(r.imported, null);
    return {
      id: r.id,
      versionId: r.versionId,
      status: imp?.status ?? r.status,
      instructions: r.instructions,
      dueDate: iso(r.dueDate),
      sequential: r.sequential,
      submittedBy: (imp && ext(imp.submittedBy)) || person(r.submittedById),
      createdAt: iso(r.createdAt),
      closedAt: iso(r.closedAt),
      commitId: options.history ? r.commitId : null,
      lineage: imp?.keys ?? [],
      from: imp?.from ?? null,
      assignments: r.assignments.map((a) => {
        const ai = jsonOr<AssignmentImport | null>(a.imported, null);
        return {
          id: a.id,
          order: a.order,
          who: ai ? ext(ai.who) : a.userId ? person(a.userId) : null,
          group: ai ? ai.group : a.userId ? null : a.groupName ?? a.groupId,
          canApprove: a.canApprove,
          decision: a.decision,
          reason: a.reason,
          decidedBy: ai ? ext(ai.decidedBy) : a.decidedById ? person(a.decidedById) : null,
          decidedAt: iso(a.decidedAt),
        };
      }),
    };
  });

  const voltSignatures: VoltSignature[] = [
    ...signatures.map((s) => ({
      id: s.id,
      versionId: s.versionId,
      signatory: person(s.signatoryId),
      purpose: s.purpose,
      order: s.order,
      status: s.status,
      docHash: s.docHash,
      pdfHash: s.pdfHash,
      provider: s.provider,
      signedAt: iso(s.signedAt),
      declineReason: s.declineReason,
      createdAt: iso(s.createdAt),
      evidence: input.canManage ? jsonOr<Record<string, unknown> | null>(s.evidence, null) : null,
      seal: input.canManage ? s.seal : null,
      importedFrom: null,
    })),
    ...carriedSignatures,
  ];

  // attachments and component documents
  const files: VoltFile[] = [];
  const fileData = new Map<string, Uint8Array>();
  if (options.files) {
    const commentIds = new Set(comments.map((c) => c.id));
    const reviewIds = new Set(reviews.map((r) => r.id));
    const atts = await db.attachment.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } });
    for (const a of atts) {
      const keep = a.ownerType === "PROJECT" || (a.ownerType === "RELEASE" && versionIds.has(a.ownerId)) || (a.ownerType === "COMMENT" && commentIds.has(a.ownerId)) || (a.ownerType === "REVIEW" && reviewIds.has(a.ownerId));
      if (!keep) continue;
      uids.add(a.userId);
      files.push({ id: a.id, kind: "attachment", path: null, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256, createdAt: iso(a.createdAt), uploadedBy: person(a.userId), ownerType: a.ownerType, ownerId: a.ownerId, docKind: null, title: null, url: null, elementId: null, manufacturer: null, partNumber: null });
      fileData.set(a.id, a.data);
    }
    // datasheets etc. of placed components (library documents stay with the library)
    const elementIds = new Set<string>();
    for (const d of drawings.values()) for (const p of d.pages) for (const e of p.elements) elementIds.add(e.id);
    const docs = await db.partDocument.findMany({ where: { scope: "COMPONENT", projectId: project.id }, orderBy: { createdAt: "asc" } });
    for (const d of docs) {
      if (!d.elementId || !elementIds.has(d.elementId)) continue;
      files.push({ id: d.id, kind: "document", path: null, filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256, createdAt: iso(d.createdAt), uploadedBy: person(d.createdById), ownerType: null, ownerId: null, docKind: d.kind, title: d.title, url: d.url, elementId: d.elementId, manufacturer: d.manufacturer, partNumber: d.partNumber });
      if (d.data) fileData.set(d.id, d.data);
    }
    // uploaders we have not loaded yet
    const missing = [...uids].filter((u) => !users.has(u));
    if (missing.length) for (const u of await db.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, email: true, isBot: true } })) users.set(u.id, u);
    for (const f of files) if (f.uploadedBy.name === "Unknown") f.uploadedBy = person(f.uploadedBy.id);
  }

  const bundle: VoltBundle = {
    project: {
      id: project.id,
      name: project.name,
      number: project.number,
      description: project.description,
      tags: jsonOr<string[]>(project.tags, []),
      versionScheme: project.versionScheme,
      customScheme: project.customScheme,
      createdAt: iso(project.createdAt),
      createdBy: person(project.createdById),
    },
    variants: variants.map((x) => ({ id: x.id, code: x.code, name: x.name, customer: x.customer, description: x.description, baseVersionId: versionIds.has(x.baseVersionId) ? x.baseVersionId : null, baseLabel: x.baseLabel, state: x.state, createdAt: iso(x.createdAt), createdBy: person(x.createdById) })),
    versions,
    drawings,
    commits: voltCommits,
    history,
    comments: voltComments,
    reviews: voltReviews,
    signatures: voltSignatures,
    files,
    fileData,
  };
  const keys = loadKeys();
  const header: VoltHeader = {
    scope,
    createdAt: new Date().toISOString(),
    generator: "Volt",
    server: { keyId: keys.keyId, name: serverName(ctx), url: serverUrl() },
    exportedBy: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
    project: { id: project.id, name: project.name, number: project.number },
    includes: options,
  };
  const { bytes, manifest } = packVolt(header, bundle, { priv: keys.priv, keyId: keys.keyId, pubPem: keys.pubPem });
  const filename = voltFilename(project, scope === "version" ? rows[0]?.label : undefined);
  return { bytes, manifest, filename, project };
}
