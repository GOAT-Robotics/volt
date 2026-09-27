import { rateLimit } from "@/lib/ratelimit";
import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { reqMeta } from "@/lib/access";
import { signSignature } from "@/lib/signing/service";

export const runtime = "nodejs";

const Body = z.object({ fullName: z.string().trim().min(1, "Type your full name").max(200), accept: z.literal(true, { message: "Confirm the signature statement" }) });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  rateLimit(`sign:${ctx.user.id}`, 10);
  const { id } = await params;
  const b = await body(req, Body);
  return signSignature(ctx, id, { fullName: b.fullName, ...reqMeta(req) });
});
