import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { loadVersion } from "@/lib/versioning";
import { releaseVersion } from "@/lib/release";

export const runtime = "nodejs";

const Body = z.object({ note: z.string().max(2000).default("") });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const a = await loadVersion(ctx, id, { withDoc: false });
  if (!a.can("project.manage")) throw new HttpError(403, "Only project owners can do this");
  return { ok: true, ...(await releaseVersion(ctx, id, b.note)) };
});
