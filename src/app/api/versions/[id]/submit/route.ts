import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { submitForReview } from "@/lib/submit";

export const runtime = "nodejs";

const Body = z.object({
  reviewers: z
    .array(z.object({ userId: z.string().min(1) }))
    .min(1, "Add at least one reviewer")
    .max(30),
  dueDate: z.string().nullish(),
  instructions: z.string().max(10_000).default(""),
  /** message for committing what is not committed yet (default: "Submitted for review") */
  commitMessage: z.string().trim().max(2000).optional(),
  sequential: z.boolean().default(false),
});

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const r = await submitForReview(ctx, id, b);
  return { reviewId: r.reviewId, aiReview: r.aiReview };
});
