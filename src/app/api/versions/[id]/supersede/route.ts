import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { supersedeVersion } from "@/lib/release";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().min(1, "A reason is required").max(2000) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.can("project.manage")) throw new HttpError(403, "Only project owners can do this");
  return { ok: true, ...(await supersedeVersion(ctx, id, b.reason)) };
});
