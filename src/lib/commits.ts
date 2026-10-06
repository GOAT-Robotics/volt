/**
 * Git-like history inside versions.
 *
 *  - The working copy is the version's document (autosaved as you draw).
 *  - A commit records a snapshot with a message and the list of changes against its parent; only
 *    the changes are shown.
 *  - Commits chain across versions: a version's first commit continues from the commit its parent
 *    version ended at. Versions (v1, v2, 2-ACME.1) are the tags; variants are branches.
 *  - Submitting for review commits what is not committed yet: the review covers exactly that commit,
 *    like a pull request; approval and signatures are the merge and the release.
 *  - Restoring an old commit (or version) copies it into the working copy as an ordinary,
 *    undoable change in the editor — then commit it.
 */
import "server-only";
import { gzipSync, gunzipSync } from "node:zlib";
import { db } from "./db";
import { HttpError, type Ctx } from "./session";
import { clientDoc, docHash, parseDoc } from "./versioning";
import { diffDocs, type Change } from "@/core/diff";
import type { Doc } from "@/core/model";

export type CommitStats = { added: number; removed: number; changed: number; moved: number; items: Pick<Change, "kind" | "area" | "pageId" | "id" | "label" | "details">[]; total: number };

export const packDoc = (doc: Doc) => gzipSync(Buffer.from(JSON.stringify(clientDoc(doc))), { level: 6 });
export const unpackDoc = (b: Uint8Array): Doc => JSON.parse(gunzipSync(b).toString("utf8")) as Doc;

/** an empty drawing to diff the very first commit of a project against */
function emptyLike(d: Doc): Doc {
  return { ...d, meta: { title: d.meta.title, props: {} }, pages: [], defs: {}, cables: [], terminalStrips: [] };
}

export function statsOf(before: Doc | null, after: Doc): CommitStats {
  const diff = diffDocs(before ?? emptyLike(after), after);
  return { ...diff.summary, total: diff.changes.length, items: diff.changes.slice(0, 400).map((c) => ({ kind: c.kind, area: c.area, pageId: c.pageId, id: c.id, label: c.label, details: c.details?.slice(0, 6) })) };
}

export async function commitDoc(id: string): Promise<Doc | null> {
  const c = await db.commit.findUnique({ where: { id }, select: { data: true } });
  return c ? unpackDoc(c.data) : null;
}

/** what the working copy is compared with: the head commit, else where the version started */
export async function baselineOf(v: { id: string; headCommitId: string | null; baseCommitId: string | null; parentId: string | null }): Promise<{ kind: "commit" | "version" | "empty"; id: string | null; doc: Doc | null; label: string }> {
  const cid = v.headCommitId ?? v.baseCommitId;
  if (cid) {
    const c = await db.commit.findUnique({ where: { id: cid }, select: { id: true, seq: true, data: true } });
    if (c) return { kind: "commit", id: c.id, doc: unpackDoc(c.data), label: `#${c.seq}` };
  }
  if (v.parentId) {
    const p = await db.version.findUnique({ where: { id: v.parentId }, select: { id: true, label: true, doc: true, headCommitId: true } });
    if (p?.headCommitId) {
      const c = await db.commit.findUnique({ where: { id: p.headCommitId }, select: { id: true, seq: true, data: true } });
      if (c) return { kind: "commit", id: c.id, doc: unpackDoc(c.data), label: `#${c.seq}` };
    }
    if (p) return { kind: "version", id: p.id, doc: clientDoc(parseDoc(p.doc)), label: `v${p.label}` };
  }
  return { kind: "empty", id: null, doc: null, label: "empty drawing" };
}

/** Commit the version's current document. Returns null when there is nothing to commit (and `allowEmpty` is false). */
export async function createCommit(ctx: Ctx, versionId: string, message: string, kind: "COMMIT" | "SUBMIT" | "RESTORE" | "AUTO" = "COMMIT", opts: { allowEmpty?: boolean } = {}) {
  const v = await db.version.findUnique({ where: { id: versionId } });
  if (!v) throw new HttpError(404, "Version not found");
  const doc = clientDoc(parseDoc(v.doc));
  const hash = docHash(doc);
  const base = await baselineOf(v);
  const parentHash = base.doc ? docHash(base.doc) : null;
  if (parentHash === hash && !opts.allowEmpty) return null;
  const stats = statsOf(base.doc, doc);
  // sequence numbers are per project (short ids "#12"); retry on a concurrent commit
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await db.commit.findFirst({ where: { projectId: v.projectId }, orderBy: { seq: "desc" }, select: { seq: true } });
    try {
      const c = await db.$transaction(async (tx) => {
        const created = await tx.commit.create({
          data: { projectId: v.projectId, versionId, parentId: base.kind === "commit" ? base.id : null, seq: (last?.seq ?? 0) + 1, kind, message: message.trim().slice(0, 2000), docHash: hash, data: packDoc(doc), stats: JSON.stringify(stats), authorId: ctx.user.id },
        });
        await tx.version.update({ where: { id: versionId }, data: { headCommitId: created.id } });
        return created;
      });
      return c;
    } catch (e) {
      if (!String((e as Error).message).includes("Unique constraint")) throw e;
    }
  }
  throw new HttpError(409, "Could not commit — try again");
}

export type HistoryEntry =
  | { type: "commit"; id: string; seq: number; kind: string; message: string; author: string; createdAt: string; stats: Omit<CommitStats, "items">; versionId: string; versionLabel: string; branch: string; tags: { label: string; status: string }[]; current: boolean; head: boolean }
  | { type: "version"; id: string; versionId: string; versionLabel: string; status: string; summary: string; createdAt: string; author: string; branch: string };

const FROZEN = (s: string) => !["DRAFT", "CHANGES_REQUESTED"].includes(s);

/** commits and tags reachable from a version, newest first (crossing into the versions it started from) */
export async function historyOf(versionId: string, limit = 300): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = [];
  const versions = new Map<string, { id: string; label: string; status: string; summary: string; createdAt: Date; createdById: string; parentId: string | null; baseCommitId: string | null; headCommitId: string | null; variantId: string | null }>();
  const loadV = async (id: string) => {
    if (!versions.has(id)) {
      const v = await db.version.findUnique({ where: { id }, select: { id: true, label: true, status: true, summary: true, createdAt: true, createdById: true, parentId: true, baseCommitId: true, headCommitId: true, variantId: true } });
      if (v) versions.set(id, v);
    }
    return versions.get(id) ?? null;
  };
  const variantCodes = new Map<string, string>();
  const branchOf = async (variantId: string | null) => {
    if (!variantId) return "main";
    if (!variantCodes.has(variantId)) variantCodes.set(variantId, (await db.variant.findUnique({ where: { id: variantId }, select: { code: true } }))?.code ?? "variant");
    return variantCodes.get(variantId)!;
  };
  const users = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!users.has(id)) users.set(id, (await db.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? "Unknown");
    return users.get(id)!;
  };
  let cur = await loadV(versionId);
  let upToSeq: number | null = null;
  const seen = new Set<string>();
  while (cur && out.length < limit && !seen.has(cur.id)) {
    seen.add(cur.id);
    const commits = await db.commit.findMany({ where: { versionId: cur.id, ...(upToSeq !== null ? { seq: { lte: upToSeq } } : {}) }, orderBy: { seq: "desc" }, take: limit - out.length, omit: { data: true } });
    const branch = await branchOf(cur.variantId);
    if (!commits.length) {
      out.push({ type: "version", id: `v:${cur.id}`, versionId: cur.id, versionLabel: cur.label, status: cur.status, summary: cur.summary, createdAt: cur.createdAt.toISOString(), author: await nameOf(cur.createdById), branch });
    }
    for (const c of commits) {
      const s = JSON.parse(c.stats || "{}") as Partial<CommitStats>;
      const tags = cur.headCommitId === c.id && FROZEN(cur.status) ? [{ label: cur.label, status: cur.status }] : [];
      out.push({
        type: "commit",
        id: c.id,
        seq: c.seq,
        kind: c.kind,
        message: c.message,
        author: await nameOf(c.authorId),
        createdAt: c.createdAt.toISOString(),
        stats: { added: s.added ?? 0, removed: s.removed ?? 0, changed: s.changed ?? 0, moved: s.moved ?? 0, total: s.total ?? 0 },
        versionId: cur.id,
        versionLabel: cur.label,
        branch,
        tags,
        current: cur.id === versionId,
        head: cur.headCommitId === c.id,
      });
    }
    // continue where this version started
    if (cur.baseCommitId) {
      const b = await db.commit.findUnique({ where: { id: cur.baseCommitId }, select: { versionId: true, seq: true } });
      if (!b) break;
      upToSeq = b.seq;
      cur = await loadV(b.versionId);
    } else if (cur.parentId) {
      upToSeq = null;
      cur = await loadV(cur.parentId);
    } else break;
  }
  return out;
}

/** is `commitId` reachable from the version (so it may be restored / branched from)? */
export async function inLineage(versionId: string, commitId: string) {
  const h = await historyOf(versionId, 2000);
  return h.some((e) => e.type === "commit" && e.id === commitId);
}
