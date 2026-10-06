import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { clientDoc, loadVersion, parseDoc } from "@/lib/versioning";
import { unpackDoc } from "@/lib/commits";
import { diffDocs } from "@/core/diff";
import type { Doc } from "@/core/model";

export const runtime = "nodejs";

/**
 * Everything this version changes against where it started (the parent version / commit) — the
 * "files changed" of a pull request, shown to reviewers.
 */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id);
  const v = a.version;
  let base: Doc | null = null;
  let label = "an empty drawing";
  if (v.baseCommitId) {
    const c = await db.commit.findUnique({ where: { id: v.baseCommitId }, select: { data: true, seq: true, version: { select: { label: true } } } });
    if (c) ((base = unpackDoc(c.data)), (label = `v${c.version.label} (#${c.seq})`));
  }
  if (!base && v.parentId) {
    const p = await db.version.findUnique({ where: { id: v.parentId }, select: { doc: true, label: true } });
    if (p) ((base = clientDoc(parseDoc(p.doc))), (label = `v${p.label}`));
  }
  const cur = clientDoc(parseDoc(v.doc));
  if (!base) return { base: label, summary: { added: 0, removed: 0, changed: 0, moved: 0 }, changes: [], total: 0, initial: true };
  const d = diffDocs(base, cur);
  return { base: label, summary: d.summary, total: d.changes.length, changes: d.changes.slice(0, 1500), initial: false };
});
