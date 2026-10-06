import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { assertEditable, loadVersion } from "@/lib/versioning";
import { baselineOf, createCommit, historyOf } from "@/lib/commits";
import { flushLive } from "@/lib/live/hooks";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** history of this version: its commits and those of the versions it started from, with tags and branches */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  const base = await baselineOf(a.version);
  return {
    history: await historyOf(id),
    head: a.version.headCommitId,
    baseline: { kind: base.kind, id: base.id, label: base.label },
    canCommit: a.editable,
  };
});

const Body = z.object({ message: z.string().trim().min(1, "Write a commit message").max(2000) });

/** commit the working copy (save in the editor first) */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  await flushLive(id);
  const a = await loadVersion(ctx, id, { withDoc: false });
  assertEditable(a);
  const c = await createCommit(ctx, id, b.message);
  if (!c) throw new HttpError(409, "Nothing to commit — the drawing is the same as the last commit", "NOTHING");
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "version.commit", data: { label: a.version.label, seq: c.seq, message: b.message } });
  await db.project.update({ where: { id: a.project.id }, data: { updatedAt: new Date() } });
  return { id: c.id, seq: c.seq };
});
