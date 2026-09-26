import { z } from "zod";
import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { assertEditable, docHash, loadVersion, parseDoc, reindexVersion } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import type { Doc } from "@/core/model";

export const runtime = "nodejs";
const MAX = 60 * 1024 * 1024;

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id);
  return { doc: parseDoc(a.version.doc), label: a.version.label, status: a.version.status, docRev: a.version.docRev };
});

const Body = z.object({
  baseRev: z.number().int(),
  doc: z
    .object({ schema: z.literal(1), meta: z.object({ title: z.string() }).passthrough(), pages: z.array(z.object({ id: z.string() }).passthrough()).min(1), defs: z.record(z.string(), z.unknown()) })
    .passthrough(),
});

async function save(req: Request, id: string) {
  const ctx = await apiCtx();
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX) throw new HttpError(413, "Document too large");
  const text = await req.text();
  if (text.length > MAX) throw new HttpError(413, "Document too large");
  const body = Body.parse(JSON.parse(text));
  const a = await loadVersion(ctx, id, { withDoc: false });
  assertEditable(a);
  const doc = body.doc as unknown as Doc;
  const res = await db.version.updateMany({
    where: { id, docRev: body.baseRev, status: { in: ["DRAFT", "CHANGES_REQUESTED"] } },
    data: { doc: JSON.stringify(doc), docRev: { increment: 1 }, docHash: docHash(doc) },
  });
  if (res.count === 0) {
    const cur = await db.version.findUnique({ where: { id }, select: { docRev: true, status: true } });
    throw new HttpError(409, cur && cur.docRev !== body.baseRev ? "This version was saved from another session." : "Version is no longer editable", "CONFLICT");
  }
  // one audit entry per user/version per 10 minutes keeps the trail meaningful
  const recent = await db.auditEvent.findFirst({ where: { versionId: id, actorId: ctx.user.id, type: "version.save", createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } });
  if (!recent) await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "version.save", data: { rev: body.baseRev + 1 } });
  await db.project.update({ where: { id: a.project.id }, data: { updatedAt: new Date() } });
  void reindexVersion(id, a.project.id, doc).catch((e) => console.error("[reindex]", e));
  return { rev: body.baseRev + 1 };
}

export const PUT = route<{ id: string }>(async (req, { params }) => save(req, (await params).id));
/** navigator.sendBeacon flushes use POST */
export const POST = route<{ id: string }>(async (req, { params }) => save(req, (await params).id));
