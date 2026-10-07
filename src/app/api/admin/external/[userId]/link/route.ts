import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { createLoginLink, mailLoginLink } from "@/lib/magiclink";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const Body = z.object({ send: z.boolean().default(true) });

/** New invitation link: emailed to the partner, or (send: false / no mail) returned for the admin to pass on. */
export const POST = route<{ userId: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  rateLimit(`magic:admin:${ctx.user.id}`, 30);
  const { userId } = await params;
  const b = await body(req, Body);
  const m = await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ctx.workspace.id, userId } }, include: { user: { include: { projectMembers: { where: { project: { workspaceId: ctx.workspace.id } }, include: { project: { select: { name: true } } } } } } } });
  if (!m || !m.user.external) throw new HttpError(404, "External user not found");
  if (m.user.disabled) throw new HttpError(409, "Enable the account first");
  if (m.user.accessUntil && m.user.accessUntil.getTime() < Date.now()) throw new HttpError(409, "Their access has ended — extend the end date first");
  const link = await createLoginLink(userId, "invite", ctx.user.id, req);
  const mailed = b.send && (await mailLoginLink(m.user, link.url, link.expiresAt, { workspace: ctx.workspace.name, invitedBy: ctx.user.name, projects: m.user.projectMembers.map((p) => p.project.name) }));
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.external", data: { action: mailed ? "link emailed" : "link copied by admin", user: m.user.email } });
  return { ok: true, mailed, link: mailed ? null : link.url, expiresAt: link.expiresAt.toISOString() };
});
