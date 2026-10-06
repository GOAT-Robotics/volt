import { after } from "next/server";
import { route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion, flushReindex } from "@/lib/versioning";
import { rateLimit } from "@/lib/ratelimit";
import { aiEnabled, aiModel } from "@/lib/ai/openai";
import { aiReviewStatus, aiRunning, runAiReview } from "@/lib/ai/review";
import { flushLive } from "@/lib/live/hooks";

export const runtime = "nodejs";

const RUNNABLE = ["DRAFT", "CHANGES_REQUESTED", "IN_REVIEW"];

/** status of the AI reviewer for this version (running / last result) and whether the viewer may run it */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  const cfg = ctx.settings.aiReview;
  return {
    enabled: cfg.enabled,
    model: cfg.useModel && aiEnabled() ? aiModel() : null,
    canRun: cfg.enabled && RUNNABLE.includes(a.version.status) && (a.can("project.edit") || a.can("review.decide")),
    ...(await aiReviewStatus(id)),
  };
});

/** run it now (in the background); poll GET for the result */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!ctx.settings.aiReview.enabled) throw new HttpError(409, "The AI reviewer is turned off for this workspace");
  if (!a.can("project.edit") && !a.can("review.decide")) throw new HttpError(403, "Only designers and reviewers can run the AI review");
  if (!RUNNABLE.includes(a.version.status)) throw new HttpError(409, "The AI review runs on drafts and versions in review");
  if (aiRunning(id)) return { started: false, running: true };
  rateLimit(`ai-review:${ctx.user.id}`, 10, 600_000);
  // review the latest state: unsaved live edits and pending search rows first
  await flushLive(id);
  await flushReindex(id);
  after(() => runAiReview(id, { trigger: "manual", actorId: ctx.user.id }));
  return { started: true, running: true };
});
