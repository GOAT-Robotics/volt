import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { docHash, flushReindex, loadVersion, parseDoc } from "@/lib/versioning";
import { audit } from "@/lib/audit";
import { startReview } from "@/lib/workflow";
import { requiredFieldsFor } from "@/lib/projects";
import { missingFields } from "@/lib/templates";

export const runtime = "nodejs";

const Body = z.object({
  reviewers: z
    .array(z.union([z.object({ userId: z.string().min(1) }), z.object({ groupId: z.string().min(1).max(100), groupName: z.string().max(200).optional() })]))
    .min(1, "Add at least one reviewer")
    .max(30),
  dueDate: z.string().nullish(),
  instructions: z.string().max(10_000).default(""),
  sequential: z.boolean().default(false),
});

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  await flushReindex(id);
  const a = await loadVersion(ctx, id);
  if (!a.can("project.edit") && !a.can("project.manage")) throw new HttpError(403, "You cannot submit this version");
  if (!["DRAFT", "CHANGES_REQUESTED"].includes(a.version.status)) throw new HttpError(409, "Only draft versions can be submitted");
  if (a.project.state !== "ACTIVE") throw new HttpError(409, "Project is archived");
  const doc = parseDoc(a.version.doc);
  const missing = missingFields(doc, await requiredFieldsFor(a.project));
  if (missing.length) throw new HttpError(400, `Fill in the required project properties first: ${missing.join(", ")}`);
  let due: Date | null = null;
  if (b.dueDate) {
    due = new Date(b.dueDate);
    if (Number.isNaN(due.getTime())) throw new HttpError(400, "Invalid due date");
  }
  // freeze: record the hash of exactly what is being reviewed
  await db.version.update({ where: { id }, data: { docHash: docHash(doc) } });
  const review = await startReview(ctx, { ...a.version, project: a.project }, { reviewers: b.reviewers, dueDate: due, instructions: b.instructions, sequential: b.sequential });
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "version.submit", data: { label: a.version.label, reviewers: b.reviewers.length, sequential: b.sequential, due: b.dueDate ?? null } });
  return { reviewId: review.id };
});
