import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { closeThreads } from "@/lib/comment-actions";

export const runtime = "nodejs";

/** ids: these threads · ai: every open AI reviewer finding of the version ("Clear AI findings") */
const Body = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(500).optional(),
  ai: z.literal(true).optional(),
  status: z.enum(["RESOLVED", "REJECTED"]),
  note: z.string().trim().min(1, "Add a note — it is posted on every thread").max(2000),
});

/** Resolve / won't-fix many open threads with one note (lib/comment-actions › closeThreads). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  await loadVersion(ctx, id, { withDoc: false });
  if (!b.ids?.length && !b.ai) throw new HttpError(400, "Say which threads to close");
  return closeThreads(ctx, id, b.ids?.length ? { ids: b.ids } : { ai: true }, b.status, b.note);
});
