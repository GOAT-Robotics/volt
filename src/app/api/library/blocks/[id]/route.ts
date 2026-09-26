import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { assertMember, loadElement } from "@/lib/library/access";
import { updateElement } from "@/lib/library/update";

export const runtime = "nodejs";

const Put = z.object({
  content: z.object({ defs: z.record(z.string(), z.unknown()), elements: z.array(z.unknown()), wires: z.array(z.unknown()), bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }).passthrough().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  category: z.string().max(400).optional(),
  tags: z.array(z.string()).optional(),
  note: z.string().max(500).optional(),
  baseRevision: z.number().int().optional(),
});

/** Publish a new revision of a block (and/or update its metadata). */
export const PUT = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  if (a.el.kind !== "BLOCK") throw new HttpError(400, "Not a block");
  const b = await body(req, Put);
  const { content, ...rest } = b;
  return updateElement(ctx, a, { ...rest, content: content ? JSON.stringify({ junctions: [], texts: [], ports: [], ...content }) : undefined });
});
