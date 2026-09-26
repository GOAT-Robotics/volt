import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { declineSignature } from "@/lib/signing/service";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().min(1, "A reason is required").max(2000) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  await declineSignature(ctx, id, b.reason);
  return { ok: true };
});
