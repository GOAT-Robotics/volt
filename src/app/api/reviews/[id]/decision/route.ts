import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { decide } from "@/lib/workflow";
import { reqMeta } from "@/lib/access";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** fullName: approving signs — the approver types their full name */
const Body = z.object({ decision: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]), reason: z.string().max(5000).default(""), fullName: z.string().trim().max(200).optional() });

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const r = await db.review.findUnique({ where: { id }, include: { version: { select: { projectId: true } } } });
  if (!r) throw new HttpError(404, "Review not found");
  const { projectRoles } = await loadProject(ctx, r.version.projectId);
  if (b.decision === "APPROVED") rateLimit(`sign:${ctx.user.id}`, 10);
  const res = await decide(ctx, id, projectRoles, b.decision, b.reason, b.decision === "APPROVED" ? { fullName: b.fullName ?? "", ...reqMeta(req) } : undefined);
  return { ok: true, versionStatus: res.versionStatus };
});
