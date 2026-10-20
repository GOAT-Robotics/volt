/**
 * Submitting a working version for review (the web app's Submit dialog and the MCP server):
 * required project properties, freeze the hash, commit what is not committed, start the review,
 * freeze the live room, audit, and the AI reviewer's first pass in the background.
 */
import "server-only";
import { after } from "next/server";
import { HttpError, type Ctx } from "./session";
import { db } from "./db";
import { docHash, flushReindex, loadVersion, parseDoc } from "./versioning";
import { audit } from "./audit";
import { startReview } from "./workflow";
import { requiredFieldsFor } from "./projects";
import { missingFields } from "./templates";
import { liveReadonly } from "./live/hooks";
import { runAiReview } from "./ai/review";
import { createCommit } from "./commits";

export type SubmitInput = { reviewers: { userId: string }[]; dueDate?: string | null; instructions?: string; commitMessage?: string; sequential?: boolean };

export async function submitForReview(ctx: Ctx, id: string, b: SubmitInput, o: { via?: string } = {}) {
  await flushReindex(id);
  const a = await loadVersion(ctx, id);
  if (!a.can("project.edit") && !a.can("project.manage")) throw new HttpError(403, "You cannot submit this version");
  if (!["DRAFT", "CHANGES_REQUESTED"].includes(a.version.status)) throw new HttpError(409, "Only draft versions can be submitted");
  if (a.project.state !== "ACTIVE") throw new HttpError(409, "Project is archived");
  if (!b.reviewers.length) throw new HttpError(400, "Add at least one reviewer");
  const doc = parseDoc(a.version.doc);
  const missing = missingFields(doc, await requiredFieldsFor(a.project));
  if (missing.length) throw new HttpError(400, `Fill in the required project properties first: ${missing.join(", ")}`);
  let due: Date | null = null;
  if (b.dueDate) {
    due = new Date(b.dueDate);
    if (Number.isNaN(due.getTime())) throw new HttpError(400, "Invalid due date");
  }
  const instructions = b.instructions ?? "";
  // freeze: record the hash of exactly what is being reviewed
  await db.version.update({ where: { id }, data: { docHash: docHash(doc) } });
  // the review covers a commit (like a pull request): commit what is not committed yet
  await createCommit(ctx, id, b.commitMessage || `Submitted for review${instructions ? `: ${instructions.split("\n")[0].slice(0, 120)}` : ""}`, "SUBMIT");
  const review = await startReview(ctx, { ...a.version, project: a.project }, { reviewers: b.reviewers, dueDate: due, instructions, sequential: !!b.sequential });
  liveReadonly(id, `Submitted for review by ${ctx.user.name || ctx.user.email} — this version is now frozen`);
  await audit({ workspaceId: a.project.workspaceId, projectId: a.project.id, versionId: id, actorId: ctx.user.id, type: "version.submit", data: { label: a.version.label, reviewers: b.reviewers.length, sequential: !!b.sequential, due: b.dueDate ?? null, ...(o.via ? { via: o.via } : {}) } });
  // the AI reviewer does the first pass in the background; its findings arrive as comments
  const ai = ctx.settings.aiReview;
  if (ai.enabled && ai.onSubmit) after(() => runAiReview(id, { trigger: "submit", actorId: null }));
  return { reviewId: review.id, aiReview: ai.enabled && ai.onSubmit, version: a };
}
