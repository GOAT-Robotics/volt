/**
 * Import a .volt file: inspect it, open it as a new project, or merge the reviews of a reviewed
 * copy back into the version it came from. See ./format.ts and docs/VOLT_FORMAT.md.
 *
 * Trust: a file proves only what its seal proves. Approvals, review decisions and signatures in a
 * file are records — they never count here (imported versions are read-only IMPORTED records,
 * signature records never become Signature rows, imported reviews are never OPEN). People are
 * mapped to accounts here only when this server sealed the file itself; everyone else is shown
 * with the name and email from the file, imported by the person who uploaded it.
 */
import "server-only";
import { createPublicKey, verify } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { can, HttpError, loadProject, type Ctx } from "../session";
import { docHash, reindexVersion, sha256 } from "../versioning";
import { packDoc, statsOf } from "../commits";
import { clientDoc } from "../versioning";
import { loadKeys } from "../signing/builtin";
import { allowedMime, MAX_ATTACHMENT } from "../uploads";
import { DOC_KINDS } from "../documents";
import { audit } from "../audit";
import { notify } from "../notify";
import { projectManagers } from "../access";
import { flushLive } from "../live/hooks";
import { stableStringify } from "@/core/stable-json";
import type { CompatItem, CompatReport, Doc } from "@/core/model";
import { importStatuses, keyOf, keysOf, readVolt, VoltError, MAX_VOLT_FILE, type Person, type VoltBundle, type VoltCheck, type VoltComment, type VoltManifest, type VoltVersion } from "./format";
import { statusLabel, type AssignmentImport, type ExternalAuthor, type ExternalPerson, type ImportedSignature, type MergeCandidate, type MergeResult, type ReviewImport, type SealState, type VersionImport, type VoltInspection } from "./types";

export type ParsedVolt = {
  filename: string;
  bytes: Buffer<ArrayBuffer>;
  sha256: string;
  manifest: VoltManifest;
  bundle: VoltBundle;
  check: VoltCheck;
  /** this server sealed the file (and it is unchanged): ids and people in it are this server's */
  trusted: boolean;
  myKeyId: string;
};

const COMMENT_STATUSES = ["OPEN", "RESOLVED", "REJECTED", "REOPENED"];
const plural = (n: number, w: string, pl = w + "s") => `${n} ${n === 1 ? w : pl}`;
const when = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/* ------------------------------------------------------------------ */
/* Reading the upload                                                   */
/* ------------------------------------------------------------------ */

export async function parseVoltUpload(file: unknown): Promise<ParsedVolt> {
  if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
  if (file.size > MAX_VOLT_FILE) throw new HttpError(413, `File exceeds the ${MAX_VOLT_FILE / 1024 / 1024} MB limit`);
  const filename = (file.name || "project.volt").split(/[\\/]/).pop()!.slice(0, 200);
  if (!/\.volt$/i.test(filename)) throw new HttpError(415, "Choose a Volt project file (.volt)");
  const bytes = Buffer.from(await file.arrayBuffer());
  let r: ReturnType<typeof readVolt>;
  try {
    r = readVolt(bytes);
  } catch (e) {
    if (e instanceof VoltError) throw new HttpError(422, e.message);
    throw e;
  }
  const myKeyId = loadKeys().keyId;
  return { filename, bytes, sha256: sha256(bytes), ...r, trusted: r.check.sealValid && r.check.keyId === myKeyId, myKeyId };
}

function sealState(p: ParsedVolt): { state: SealState; detail: string } {
  const m = p.manifest;
  if (p.trusted) return { state: "this-server", detail: "Unchanged since it was exported from this Volt server." };
  if (p.check.sealValid) return { state: "valid", detail: `Unchanged since it was exported${m.server.url ? ` from ${m.server.url}` : ""}. Key ${p.check.keyId}.` };
  if (!p.check.sealed) return { state: "unsealed", detail: "Not sealed: the content cannot be traced to a Volt server. People and records in it are shown as they are written in the file." };
  return { state: "invalid", detail: `${p.check.problems[0] ?? "The seal does not verify"}. The content is treated as unverified.` };
}

/** server a record was made on: its own note, else the exporting server */
const fromOf = (p: ParsedVolt, rec: { from?: string | null }) => rec.from || p.manifest.server.name;

/* ------------------------------------------------------------------ */
/* People                                                               */
/* ------------------------------------------------------------------ */

type Who = { userId: string; external: ExternalPerson | null };

/** Maps people in the file to accounts here (sealed by this server only); others are external. */
async function peopleResolver(ctx: Ctx, p: ParsedVolt): Promise<(x: Person | null | undefined) => Who> {
  const b = p.bundle;
  const ids = new Set<string>();
  if (p.trusted) {
    const add = (x: Person | null | undefined) => x?.id && ids.add(x.id);
    b.versions.forEach((v) => add(v.createdBy));
    b.commits.forEach((c) => add(c.author));
    b.comments.forEach((c) => add(c.author));
    b.files.forEach((f) => add(f.uploadedBy));
    add(b.project.createdBy);
  }
  const known = ids.size ? new Set((await db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true } })).map((u) => u.id)) : new Set<string>();
  return (x) => {
    if (x?.id && known.has(x.id)) return { userId: x.id, external: null };
    return { userId: ctx.user.id, external: x ? { name: x.name, ...(x.email ? { email: x.email } : {}), ...(x.bot ? { bot: true } : {}) } : { name: "Unknown" } };
  };
}

const extOf = (x: Person | null | undefined): ExternalPerson | null => (x ? { name: x.name, ...(x.email ? { email: x.email } : {}), ...(x.bot ? { bot: true } : {}) } : null);

/* ------------------------------------------------------------------ */
/* What a new-project import does                                       */
/* ------------------------------------------------------------------ */

/** check a signature's evidence seal against the key that sealed the file (same server) */
function signatureSealValid(p: ParsedVolt, evidence: Record<string, unknown> | null, seal: string | null): boolean | null {
  if (!evidence || !seal || !p.check.sealValid || !p.check.publicKey) return null;
  if (evidence.keyId !== p.check.keyId) return null;
  try {
    return verify(null, Buffer.from(stableStringify(evidence), "utf8"), createPublicKey(p.check.publicKey), Buffer.from(seal, "base64"));
  } catch {
    return false;
  }
}

function newestDoc(p: ParsedVolt): Doc {
  const b = p.bundle;
  const main = b.versions.filter((v) => !v.variantId);
  const v = (main.length ? main : b.versions).at(-1)!;
  return b.drawings.get(v.id)!;
}

function fileOk(f: VoltBundle["files"][number], data: Uint8Array | undefined): string | null {
  if (f.kind === "document" && !data) return f.url && /^https?:\/\//i.test(f.url) ? null : "a link that is not http(s)";
  if (!data) return "its contents are missing";
  if (data.byteLength > MAX_ATTACHMENT) return `larger than ${MAX_ATTACHMENT / 1024 / 1024} MB`;
  if (!allowedMime(f.filename ?? "")) return "a file type that is not allowed";
  return null;
}

export function importReport(p: ParsedVolt): CompatReport {
  const b = p.bundle;
  const m = p.manifest;
  const st = importStatuses(b.versions);
  const items: CompatItem[] = [];
  const drafts = b.versions.filter((v) => st.get(v.id) === "DRAFT");
  const records = b.versions.filter((v) => st.get(v.id) === "IMPORTED");
  const seal = sealState(p);
  items.push({ level: seal.state === "this-server" || seal.state === "valid" ? "supported" : "degraded", area: "Integrity", message: `${seal.state === "this-server" ? "Sealed by this server" : seal.state === "valid" ? `Sealed by ${m.server.name}` : seal.state === "unsealed" ? "Not sealed" : "Seal does not verify"}: ${seal.detail}` });
  items.push({ level: "supported", area: "Drawings", message: `${plural(b.versions.length, "version")}: ${b.versions.map((v) => `v${v.label}`).join(", ")}`, count: b.versions.length });
  for (const v of drafts) items.push({ level: "supported", area: "Versions", message: `v${v.label} stays a working version you can edit and submit for review here` });
  if (records.length)
    items.push({
      level: "preserved",
      area: "Versions",
      message: `${records.map((v) => `v${v.label} (${statusLabel(v.status).toLowerCase()})`).join(", ")} ${records.length === 1 ? "becomes a read-only imported record" : "become read-only imported records"} you can open, comment on and start new versions from. ${records.length === 1 ? "Its" : "Their"} approvals and signatures do not count here.`,
      count: records.length,
    });
  if (b.variants.length) items.push({ level: "supported", area: "Variants", message: b.variants.map((x) => `${x.code} — ${x.name}`).join(", "), count: b.variants.length });
  if (m.includes.history && b.commits.length) items.push({ level: "supported", area: "History", message: `${plural(b.commits.length, "commit")} with messages and authors`, count: b.commits.length });
  if (!m.includes.reviews) items.push({ level: "degraded", area: "Reviews", message: "The file was exported without comments, reviews and signature records" });
  else {
    const roots = b.comments.filter((c) => !c.parentId).length;
    if (b.comments.length) items.push({ level: "supported", area: "Comments", message: `${plural(roots, "comment thread")}, ${plural(b.comments.length - roots, "reply", "replies")}`, count: b.comments.length });
    const decided = b.reviews.flatMap((r) => r.assignments).filter((a) => a.decision !== "PENDING").length;
    if (b.reviews.length) items.push({ level: "preserved", area: "Reviews", message: `${plural(b.reviews.length, "review round")} with ${plural(decided, "decision")}, kept as a record`, count: b.reviews.length });
    for (const s of b.signatures) {
      const v = b.versions.find((x) => x.id === s.versionId);
      const ok = s.importedFrom ? s.importedFrom.sealValid : signatureSealValid(p, s.evidence, s.seal);
      items.push({
        level: "preserved",
        area: "Signatures",
        message: `v${v?.label ?? "?"}: ${s.signatory.name} — ${statusLabel(s.status).toLowerCase()}${s.signedAt ? ` ${s.signedAt.slice(0, 10)}` : ""}${ok === true ? ", seal verified" : ok === false ? ", seal does NOT verify" : ""}. Kept as a record; sign again here to release.`,
      });
    }
  }
  if (m.includes.files) {
    const skipped = b.files.filter((f) => fileOk(f, b.fileData.get(f.id)));
    const kept = b.files.length - skipped.length;
    if (kept) items.push({ level: "supported", area: "Files", message: `${plural(kept, "attachment or datasheet")}`, count: kept });
    for (const f of skipped) items.push({ level: "unsupported", area: "Files", message: `${f.filename ?? f.title ?? "A file"} is not imported: ${fileOk(f, b.fileData.get(f.id))}` });
  }
  if (!p.trusted) {
    const people = new Set<string>();
    b.comments.forEach((c) => people.add(c.author.email || c.author.name));
    b.reviews.forEach((r) => r.assignments.forEach((a) => a.who && people.add(a.who.email || a.who.name)));
    b.versions.forEach((v) => people.add(v.createdBy.email || v.createdBy.name));
    if (people.size) items.push({ level: "degraded", area: "People", message: `${plural(people.size, "person", "people")} named in the file ${people.size === 1 ? "is" : "are"} shown with the name and email the file gives (no account needed here). You become the owner of the new project.` });
  }
  const d = newestDoc(p);
  return {
    source: p.filename,
    qetVersion: `volt ${m.formatVersion}`,
    pageCount: d.pages.length,
    elementCount: d.pages.reduce((n, pg) => n + pg.elements.length, 0),
    wireCount: d.pages.reduce((n, pg) => n + pg.wires.length, 0),
    definitionCount: Object.keys(d.defs).length,
    items,
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Merge planning (reviewed copy → original version)                    */
/* ------------------------------------------------------------------ */

type MergePlan = {
  comments: { c: VoltComment; parent: string | null }[];
  /** AI reviewer findings of the other server, left out */
  automated: number;
  decisions: { key: string[]; body: string; status: string; author: ExternalPerson; at: string | null }[];
  files: number;
};

/** what is new in the file's version `fv` for the local version `localId` */
async function planMerge(p: ParsedVolt, localId: string, fv: VoltVersion): Promise<MergePlan> {
  const b = p.bundle;
  const server = p.manifest.server.keyId;
  const local = await db.comment.findMany({ where: { versionId: localId }, select: { id: true, origin: true, parentId: true } });
  const known = new Map<string, string>();
  for (const c of local) {
    const root = c.parentId ?? c.id;
    known.set(keyOf(p.myKeyId, c.id), root);
    for (const k of (c.origin ?? "").split(" ").filter(Boolean)) known.set(k, root);
  }
  const incoming = b.comments.filter((c) => c.versionId === fv.id).sort((x, y) => Number(!!x.parentId) - Number(!!y.parentId) || (x.createdAt ?? "").localeCompare(y.createdAt ?? ""));
  const map = new Map<string, string>();
  const comments: MergePlan["comments"] = [];
  // findings of the other server's AI reviewer are not brought back (this server runs its own),
  // unless a person answered them there
  const answered = new Set(incoming.filter((c) => c.parentId && !c.author.bot).map((c) => c.parentId!));
  let automated = 0;
  for (const c of incoming) {
    const hit = keysOf(c, server).map((k) => known.get(k)).find(Boolean);
    if (hit) {
      map.set(c.id, hit);
      continue;
    }
    if (c.author.bot && (c.parentId || !answered.has(c.id))) {
      if (!c.parentId) automated++;
      continue;
    }
    const parent = c.parentId ? map.get(c.parentId) ?? null : null;
    comments.push({ c, parent });
    map.set(c.id, `new:${c.id}`);
  }
  // review decisions made on the copy become comments (they never count as approvals here)
  const decisions: MergePlan["decisions"] = [];
  for (const r of b.reviews.filter((x) => x.versionId === fv.id)) {
    const rkeys = keysOf(r, server);
    if (rkeys.some((k) => k.startsWith(p.myKeyId + "/"))) continue; // our own review round
    for (const a of r.assignments) {
      if (a.decision === "PENDING") continue;
      const keys = rkeys.map((k) => `${k}:${a.id}`);
      if (keys.some((k) => known.has(k))) continue;
      const who = a.decidedBy ?? a.who;
      const name = who?.name ?? a.group ?? "A reviewer";
      decisions.push({
        key: keys,
        body: `Review decision at ${fromOf(p, r)}: ${statusLabel(a.decision)} — ${name}${who?.email ? ` (${who.email})` : ""}${a.group && who ? ` for ${a.group}` : ""}${a.reason ? `\n\n${a.reason}` : ""}`,
        status: a.decision === "APPROVED" ? "RESOLVED" : "OPEN",
        author: extOf(who) ?? { name },
        at: a.decidedAt,
      });
    }
  }
  const newIds = new Set(comments.map((x) => x.c.id));
  const files = b.files.filter((f) => f.kind === "attachment" && f.ownerType === "COMMENT" && f.ownerId && newIds.has(f.ownerId) && !fileOk(f, b.fileData.get(f.id))).length;
  return { comments, automated, decisions, files };
}

/** local versions the file's versions are copies of (by lineage), with what would be merged */
async function mergeCandidates(ctx: Ctx, p: ParsedVolt): Promise<{ cand: MergeCandidate; fv: VoltVersion; plan: MergePlan | null }[]> {
  const out: { cand: MergeCandidate; fv: VoltVersion; plan: MergePlan | null }[] = [];
  const prefix = p.myKeyId + "/";
  const seen = new Set<string>();
  for (const fv of p.bundle.versions) {
    for (const k of keysOf(fv, p.manifest.server.keyId)) {
      if (!k.startsWith(prefix)) continue;
      const id = k.slice(prefix.length);
      if (seen.has(id)) continue;
      seen.add(id);
      const v = await db.version.findUnique({ where: { id }, select: { id: true, projectId: true } });
      if (!v) continue;
      const lp = await loadProject(ctx, v.projectId).catch(() => null);
      if (!lp || !lp.can("project.view")) continue;
      await flushLive(v.id);
      const cur = await db.version.findUniqueOrThrow({ where: { id }, select: { label: true, status: true, docHash: true } });
      const plan = await planMerge(p, id, fv);
      const n = plan.comments.length + plan.decisions.length;
      const canComment = lp.can("review.comment");
      const cand: MergeCandidate = {
        projectId: lp.project.id,
        projectName: lp.project.name,
        projectNumber: lp.project.number,
        versionId: id,
        label: cur.label,
        status: cur.status,
        fileLabel: fv.label,
        newThreads: plan.comments.filter((x) => !x.parent).length,
        newReplies: plan.comments.filter((x) => x.parent).length,
        decisions: plan.decisions.length,
        files: plan.files,
        automated: plan.automated,
        drawingChanged: docHash(p.bundle.drawings.get(fv.id)!) !== cur.docHash,
        canMerge: canComment && n > 0 && lp.project.state === "ACTIVE",
        reason: !canComment ? "Your role cannot comment on this project" : lp.project.state !== "ACTIVE" ? "The project is archived" : n === 0 ? (plan.automated ? "Nothing new — only automated findings of their AI reviewer" : "Nothing new — every comment in the file is already on this version") : undefined,
      };
      out.push({ cand, fv, plan });
    }
  }
  return out;
}

export async function inspectVolt(ctx: Ctx, p: ParsedVolt): Promise<VoltInspection> {
  const b = p.bundle;
  const m = p.manifest;
  const st = importStatuses(b.versions);
  const number = b.project.number;
  const numberTaken = !!number && !!(await db.project.findFirst({ where: { workspaceId: ctx.workspace.id, number }, select: { id: true } }));
  const merge = (await mergeCandidates(ctx, p)).map((x) => x.cand);
  return {
    file: { name: p.filename, size: p.bytes.byteLength, sha256: p.sha256 },
    scope: m.scope,
    createdAt: m.createdAt,
    server: { name: m.server.name, url: m.server.url, keyId: m.server.keyId, thisServer: p.trusted },
    exportedBy: m.exportedBy.name,
    seal: sealState(p),
    project: { name: b.project.name, number, description: b.project.description, tags: b.project.tags },
    versions: b.versions.map((v) => ({
      label: v.label,
      status: v.status,
      variant: b.variants.find((x) => x.id === v.variantId)?.code ?? null,
      importsAs: st.get(v.id)!,
      comments: b.comments.filter((c) => c.versionId === v.id).length,
      reviews: b.reviews.filter((r) => r.versionId === v.id).length,
      signatures: b.signatures.filter((s) => s.versionId === v.id).length,
    })),
    counts: m.counts,
    includes: m.includes,
    report: importReport(p),
    numberTaken,
    merge,
    canCreate: can(ctx, "project.create"),
  };
}

/* ------------------------------------------------------------------ */
/* Import as a new project                                              */
/* ------------------------------------------------------------------ */

export async function importAsProject(ctx: Ctx, p: ParsedVolt, opts: { name: string; number: string | null; folderId: string | null; tags: string[] }) {
  if (!can(ctx, "project.create")) throw new HttpError(403, "Your role cannot create projects");
  const b = p.bundle;
  const m = p.manifest;
  if (opts.folderId && !(await db.folder.findFirst({ where: { id: opts.folderId, workspaceId: ctx.workspace.id } }))) throw new HttpError(400, "Folder not found");
  if (opts.number && (await db.project.findFirst({ where: { workspaceId: ctx.workspace.id, number: opts.number } }))) throw new HttpError(409, `Project number ${opts.number} is already used`);
  const who = await peopleResolver(ctx, p);
  const st = importStatuses(b.versions);
  const fileKey = m.server.keyId;
  const now = new Date();
  const report = importReport(p);

  // heavy work before the transaction: compressed history snapshots and their change lists
  const commitPrep = new Map<string, { data: ReturnType<typeof packDoc>; hash: string; stats: string }>();
  const seqs = new Set<number>();
  let nextSeq = Math.max(0, ...b.commits.map((c) => c.seq)) + 1;
  const commitSeq = new Map<string, number>();
  for (const c of b.commits) {
    const d = clientDoc(b.history.get(c.id)!);
    const parent = c.parentId ? b.history.get(c.parentId) ?? null : null;
    commitPrep.set(c.id, { data: packDoc(d), hash: docHash(d), stats: JSON.stringify(statsOf(parent ? clientDoc(parent) : null, d)) });
    commitSeq.set(c.id, seqs.has(c.seq) ? nextSeq++ : c.seq);
    seqs.add(c.seq);
  }
  const signaturesFor = (versionId: string): ImportedSignature[] =>
    b.signatures
      .filter((s) => s.versionId === versionId)
      .map((s) => ({
        signatory: extOf(s.signatory)!,
        purpose: s.purpose,
        order: s.order,
        status: s.status,
        signedAt: s.signedAt,
        declineReason: s.declineReason,
        docHash: s.docHash,
        pdfHash: s.pdfHash,
        provider: s.provider,
        server: s.importedFrom?.server ?? m.server.name,
        sealValid: s.importedFrom ? s.importedFrom.sealValid : signatureSealValid(p, s.evidence, s.seal),
        evidence: s.evidence,
        seal: s.seal,
      }));
  const scheme = ["INTEGER", "DECIMAL", "LETTER", "CUSTOM"].includes(b.project.versionScheme) ? b.project.versionScheme : "INTEGER";
  const filesSkipped: string[] = [];

  const result = await db.$transaction(
    async (tx) => {
      const project = await tx.project.create({
        data: {
          workspaceId: ctx.workspace.id,
          name: opts.name,
          number: opts.number || null,
          description: b.project.description,
          folderId: opts.folderId || null,
          tags: JSON.stringify(opts.tags),
          versionScheme: scheme,
          customScheme: scheme === "CUSTOM" ? b.project.customScheme : null,
          createdById: ctx.user.id,
          members: { create: { userId: ctx.user.id, roles: "" } },
        },
      });
      const variantId = new Map<string, string>();
      for (const x of b.variants) {
        const w = who(x.createdBy);
        const row = await tx.variant.create({ data: { projectId: project.id, code: x.code, name: x.name, customer: x.customer, description: x.description, baseVersionId: "", baseLabel: x.baseLabel, state: x.state === "ARCHIVED" ? "ARCHIVED" : "ACTIVE", createdById: w.userId, createdAt: when(x.createdAt) ?? now } });
        variantId.set(x.id, row.id);
      }
      const versionId = new Map<string, string>();
      for (const v of b.versions) {
        const doc = b.drawings.get(v.id)!;
        const w = who(v.createdBy);
        const status = st.get(v.id)!;
        const imported: VersionImport = {
          status: v.status,
          server: m.server.name,
          statusFrom: v.statusFrom ?? m.server.name,
          serverKeyId: fileKey,
          file: p.filename,
          importedAt: now.toISOString(),
          importedBy: ctx.user.name,
          keys: keysOf(v, fileKey),
          createdBy: w.external,
          trusted: p.trusted,
          signatures: signaturesFor(v.id),
        };
        const row = await tx.version.create({
          data: {
            projectId: project.id,
            variantId: v.variantId ? variantId.get(v.variantId) ?? null : null,
            seq: v.seq,
            label: v.label,
            parentId: v.parentId ? versionId.get(v.parentId) ?? null : null,
            status,
            summary: v.summary,
            description: v.description,
            ticket: v.ticket,
            doc: JSON.stringify(doc),
            docHash: docHash(doc),
            createdById: w.userId,
            createdAt: when(v.createdAt) ?? now,
            submittedAt: when(v.submittedAt),
            approvedAt: when(v.approvedAt),
            signedAt: when(v.signedAt),
            releasedAt: when(v.releasedAt),
            endedAt: when(v.endedAt),
            endReason: v.endReason,
            imported: JSON.stringify(imported),
          },
        });
        versionId.set(v.id, row.id);
      }
      for (const x of b.variants) if (x.baseVersionId && versionId.has(x.baseVersionId)) await tx.variant.update({ where: { id: variantId.get(x.id)! }, data: { baseVersionId: versionId.get(x.baseVersionId)! } });

      // history
      const commitId = new Map<string, string>();
      for (const c of b.commits) {
        const vid = versionId.get(c.versionId);
        if (!vid) continue;
        const w = who(c.author);
        const prep = commitPrep.get(c.id)!;
        const row = await tx.commit.create({
          data: { projectId: project.id, versionId: vid, parentId: c.parentId ? commitId.get(c.parentId) ?? null : null, seq: commitSeq.get(c.id)!, kind: ["COMMIT", "SUBMIT", "RESTORE", "AUTO"].includes(c.kind) ? c.kind : "COMMIT", message: c.message, docHash: prep.hash, data: prep.data, stats: prep.stats, authorId: w.userId, externalAuthor: w.external ? JSON.stringify(w.external) : null, createdAt: when(c.createdAt) ?? now },
        });
        commitId.set(c.id, row.id);
      }
      for (const v of b.versions) {
        const head = v.headCommitId ? commitId.get(v.headCommitId) : undefined;
        const base = v.baseCommitId ? commitId.get(v.baseCommitId) : undefined;
        if (head || base) await tx.version.update({ where: { id: versionId.get(v.id)! }, data: { headCommitId: head ?? null, baseCommitId: base ?? null } });
      }

      // reviews: records only (status IMPORTED: never open, never in anyone's inbox, never evaluated)
      const reviewId = new Map<string, string>();
      for (const r of b.reviews) {
        const vid = versionId.get(r.versionId);
        if (!vid) continue;
        const imp: ReviewImport = { status: r.status, submittedBy: extOf(r.submittedBy)!, from: fromOf(p, r), keys: keysOf(r, fileKey) };
        const row = await tx.review.create({
          data: {
            versionId: vid,
            submittedById: ctx.user.id,
            instructions: r.instructions,
            dueDate: when(r.dueDate),
            sequential: r.sequential,
            status: "IMPORTED",
            commitId: r.commitId ? commitId.get(r.commitId) ?? null : null,
            createdAt: when(r.createdAt) ?? now,
            closedAt: when(r.closedAt),
            imported: JSON.stringify(imp),
            assignments: {
              create: r.assignments.map((a) => ({
                order: a.order,
                canApprove: a.canApprove,
                decision: ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED"].includes(a.decision) ? a.decision : "PENDING",
                reason: a.reason,
                decidedAt: when(a.decidedAt),
                imported: JSON.stringify({ who: extOf(a.who), group: a.group, decidedBy: extOf(a.decidedBy) } satisfies AssignmentImport),
              })),
            },
          },
        });
        reviewId.set(r.id, row.id);
      }

      // comments: threads first, then replies
      const commentId = new Map<string, string>();
      const ordered = [...b.comments].sort((x, y) => Number(!!x.parentId) - Number(!!y.parentId) || (x.createdAt ?? "").localeCompare(y.createdAt ?? ""));
      for (const c of ordered) {
        const vid = c.versionId ? versionId.get(c.versionId) : null;
        if (!vid) continue;
        const parent = c.parentId ? commentId.get(c.parentId) ?? null : null;
        commentId.set(c.id, await createComment(tx, p, { projectId: project.id, versionId: vid, c, parent, who: who(c.author) }));
      }

      // attachments and component documents
      for (const f of b.files) {
        const data = b.fileData.get(f.id);
        const why = fileOk(f, data);
        if (why) {
          filesSkipped.push(f.filename ?? f.title ?? f.id);
          continue;
        }
        const w = who(f.uploadedBy);
        if (f.kind === "attachment") {
          const owner = f.ownerType === "PROJECT" ? project.id : f.ownerType === "RELEASE" ? versionId.get(f.ownerId ?? "") : f.ownerType === "COMMENT" ? commentId.get(f.ownerId ?? "") : f.ownerType === "REVIEW" ? reviewId.get(f.ownerId ?? "") : undefined;
          if (!owner || !data) continue;
          await tx.attachment.create({ data: { projectId: project.id, ownerType: f.ownerType!, ownerId: owner, filename: f.filename!, mime: allowedMime(f.filename!)!, size: data.byteLength, sha256: sha256(data), data: new Uint8Array(data), userId: w.userId, createdAt: when(f.createdAt) ?? now } });
        } else {
          await tx.partDocument.create({
            data: {
              workspaceId: ctx.workspace.id,
              scope: "COMPONENT",
              projectId: project.id,
              elementId: f.elementId,
              kind: (DOC_KINDS as readonly string[]).includes(f.docKind ?? "") ? f.docKind! : "OTHER",
              title: f.title || f.filename || "Document",
              url: data ? null : f.url,
              filename: data ? f.filename : null,
              mime: data ? allowedMime(f.filename!) : null,
              size: data ? data.byteLength : null,
              sha256: data ? sha256(data) : null,
              data: data ? new Uint8Array(data) : null,
              manufacturer: f.manufacturer,
              partNumber: f.partNumber,
              createdById: w.userId,
              createdAt: when(f.createdAt) ?? now,
            },
          });
        }
      }

      const newest = [...b.versions].reverse().find((v) => !v.variantId) ?? b.versions.at(-1)!;
      const rec = await tx.importRecord.create({ data: { projectId: project.id, versionId: versionId.get(newest.id)!, filename: p.filename, sha256: p.sha256, original: p.bytes, report: JSON.stringify(report), userId: ctx.user.id } });
      return { project, versionId, newestId: versionId.get(newest.id)!, importId: rec.id };
    },
    { timeout: 300_000, maxWait: 15_000 },
  );

  for (const v of b.versions) await reindexVersion(result.versionId.get(v.id)!, result.project.id, b.drawings.get(v.id)!);
  await audit({
    workspaceId: ctx.workspace.id,
    projectId: result.project.id,
    versionId: result.newestId,
    actorId: ctx.user.id,
    type: "project.import",
    data: { filename: p.filename, format: "volt", sha256: p.sha256, size: p.bytes.byteLength, server: m.server.name, sealed: sealState(p).state, versions: b.versions.length, comments: b.comments.length, reviews: b.reviews.length, pages: report.pageCount, elements: report.elementCount, filesSkipped: filesSkipped.length || undefined },
  });
  return { id: result.project.id, versionId: result.newestId, importId: result.importId };
}

async function createComment(tx: Prisma.TransactionClient, p: ParsedVolt, x: { projectId: string; versionId: string; c: VoltComment; parent: string | null; who: Who; keys?: string[] }) {
  const { c } = x;
  const author: ExternalAuthor | null = x.who.external ? { ...x.who.external, server: fromOf(p, c) } : null;
  const row = await tx.comment.create({
    data: {
      projectId: x.projectId,
      versionId: x.versionId,
      pageId: c.pageId,
      anchor: x.parent || !c.anchor ? null : JSON.stringify(c.anchor),
      parentId: x.parent,
      body: c.body,
      status: x.parent ? "OPEN" : COMMENT_STATUSES.includes(c.status) ? c.status : "OPEN",
      mentions: "[]",
      authorId: x.who.userId,
      externalAuthor: author ? JSON.stringify(author) : null,
      origin: (x.keys ?? keysOf(c, p.manifest.server.keyId)).join(" "),
      createdAt: when(c.createdAt) ?? new Date(),
      updatedAt: when(c.updatedAt) ?? when(c.createdAt) ?? new Date(),
    },
  });
  return row.id;
}

/* ------------------------------------------------------------------ */
/* Merge reviews back                                                   */
/* ------------------------------------------------------------------ */

export async function mergeVolt(ctx: Ctx, p: ParsedVolt, targets: string[]): Promise<MergeResult> {
  const all = await mergeCandidates(ctx, p);
  const chosen = all.filter((x) => targets.includes(x.cand.versionId));
  if (!chosen.length) throw new HttpError(400, "This file is not a reviewed copy of a version you can open here");
  const blocked = chosen.find((x) => !x.cand.canMerge);
  if (blocked) throw new HttpError(409, `v${blocked.cand.label}: ${blocked.cand.reason ?? "cannot merge"}`);
  const who = await peopleResolver(ctx, p);
  const b = p.bundle;
  const merged: MergeResult["merged"] = [];
  for (const { cand, plan } of chosen) {
    if (!plan) continue;
    const lp = await loadProject(ctx, cand.projectId);
    const created = await db.$transaction(
      async (tx) => {
        const ids = new Map<string, string>();
        let threads = 0;
        let replies = 0;
        for (const { c, parent } of plan.comments) {
          let parentId = parent?.startsWith("new:") ? ids.get(parent.slice(4)) ?? null : parent;
          if (parentId) {
            // replies hang on a thread's first comment
            const pr = await tx.comment.findUnique({ where: { id: parentId }, select: { parentId: true, versionId: true } });
            parentId = pr?.versionId === cand.versionId ? pr.parentId ?? parentId : null;
          }
          ids.set(c.id, await createComment(tx, p, { projectId: cand.projectId, versionId: cand.versionId, c, parent: parentId, who: who(c.author) }));
          if (parentId) replies++;
          else threads++;
        }
        for (const d of plan.decisions) {
          await tx.comment.create({
            data: {
              projectId: cand.projectId,
              versionId: cand.versionId,
              body: d.body,
              status: d.status,
              mentions: "[]",
              authorId: ctx.user.id,
              externalAuthor: JSON.stringify({ ...d.author, server: p.manifest.server.name } satisfies ExternalAuthor),
              origin: d.key.join(" "),
              createdAt: when(d.at) ?? new Date(),
            },
          });
        }
        let files = 0;
        for (const f of b.files) {
          if (f.kind !== "attachment" || f.ownerType !== "COMMENT" || !f.ownerId || !ids.has(f.ownerId)) continue;
          const data = b.fileData.get(f.id);
          if (fileOk(f, data) || !data) continue;
          const w = who(f.uploadedBy);
          await tx.attachment.create({ data: { projectId: cand.projectId, ownerType: "COMMENT", ownerId: ids.get(f.ownerId)!, filename: f.filename!, mime: allowedMime(f.filename!)!, size: data.byteLength, sha256: sha256(data), data: new Uint8Array(data), userId: w.userId, createdAt: when(f.createdAt) ?? new Date() } });
          files++;
        }
        const report: CompatReport = {
          source: p.filename,
          qetVersion: `volt ${p.manifest.formatVersion}`,
          pageCount: 0,
          elementCount: 0,
          wireCount: 0,
          definitionCount: 0,
          createdAt: new Date().toISOString(),
          items: [
            { level: sealState(p).state === "this-server" || sealState(p).state === "valid" ? "supported" : "degraded", area: "Integrity", message: `${p.manifest.server.name}: ${sealState(p).detail}` },
            { level: "supported", area: "Reviews", message: `Merged into v${cand.label} from v${cand.fileLabel} at ${p.manifest.server.name}: ${plural(threads, "new thread")}, ${plural(replies, "reply", "replies")}, ${plural(plan.decisions.length, "review decision")}, ${plural(files, "file")}` },
            ...(cand.drawingChanged ? [{ level: "degraded" as const, area: "Drawing", message: `The drawing in the file differs from v${cand.label}: comments are placed where they were made; drawing changes are not merged (import the file as a new project to compare).` }] : []),
          ],
        };
        await tx.importRecord.create({ data: { projectId: cand.projectId, versionId: cand.versionId, filename: p.filename, sha256: p.sha256, original: p.bytes, report: JSON.stringify(report), userId: ctx.user.id } });
        return { threads, replies, files };
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
    merged.push({ projectId: cand.projectId, versionId: cand.versionId, label: cand.label, threads: created.threads, replies: created.replies, decisions: plan.decisions.length, files: created.files });
    await audit({
      workspaceId: lp.project.workspaceId,
      projectId: cand.projectId,
      versionId: cand.versionId,
      actorId: ctx.user.id,
      type: "volt.merge",
      data: { filename: p.filename, sha256: p.sha256, server: p.manifest.server.name, sealed: sealState(p).state, label: cand.label, threads: created.threads, replies: created.replies, decisions: plan.decisions.length, files: created.files, drawingChanged: cand.drawingChanged || undefined },
    });
    const v = await db.version.findUnique({ where: { id: cand.versionId }, select: { createdById: true } });
    const people = [...new Set([...(v ? [v.createdById] : []), ...(await projectManagers(cand.projectId, lp.project.workspaceId))])].filter((u) => u !== ctx.user.id);
    const n = created.threads + created.replies + plan.decisions.length;
    await notify(people, {
      type: "review.imported",
      title: `${plural(n, "review comment")} from ${p.manifest.server.name} on ${lp.project.name} v${cand.label}`,
      body: `${ctx.user.name} merged the reviewed copy ${p.filename}.`,
      link: `/projects/${cand.projectId}/v/${cand.versionId}?panel=review`,
      workspaceId: lp.project.workspaceId,
    });
  }
  return { merged };
}
