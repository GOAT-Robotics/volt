import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { assertMember } from "@/lib/library/access";
import { rateLimit } from "@/lib/ratelimit";
import { aiEnabled, aiModel, generateSymbol } from "@/lib/ai/openai";
import type { AiSymbol } from "@/lib/library/ai-symbol";

export const runtime = "nodejs";
export const maxDuration = 130;

/** Is element generation available (OPENAI_API_KEY set)? */
export const GET = route(async () => {
  const ctx = await apiCtx();
  assertMember(ctx);
  return { enabled: aiEnabled(), model: aiEnabled() ? aiModel() : null };
});

const Body = z
  .object({
    description: z.string().max(4000).optional(),
    /** PNG / JPEG data URL (sketch or uploaded picture) */
    image: z
      .string()
      .max(6_000_000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Image must be a PNG, JPEG or WebP data URL")
      .optional(),
    previous: z.any().optional(),
    instruction: z.string().max(2000).optional(),
  })
  .refine((b) => !!b.description?.trim() || !!b.image, "Describe the element or add a sketch / picture");

/** Draw an element from a description and/or a sketch; with `previous` + `instruction`, change it. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  if (!aiEnabled()) throw new HttpError(503, "AI is not configured: set OPENAI_API_KEY in the server environment", "AI_DISABLED");
  rateLimit(`ai:${ctx.user.id}`, 20);
  const b = await body(req, Body, 8 * 1024 * 1024);
  const { symbol } = await generateSymbol({ description: b.description, image: b.image, previous: b.previous as AiSymbol | undefined, instruction: b.instruction });
  if (!symbol || !Array.isArray(symbol.shapes) || !Array.isArray(symbol.pins)) throw new HttpError(502, "The AI returned an incomplete symbol — try again");
  return { symbol, model: aiModel() };
});
