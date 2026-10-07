import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseRoles } from "@/lib/roles";
import { roleNames } from "@/lib/customroles";
import { canShareProject, SHARE_DENIED } from "@/lib/access";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const { can } = await loadProject(ctx, id);
  if (!can("project.view") && !can("review.comment")) throw new HttpError(403, "No access");
  const rows = await db.projectMember.findMany({ where: { projectId: id }, include: { user: true } });
  const memberships = await db.membership.findMany({ where: { workspaceId: ctx.workspace.id, userId: { in: rows.map((m) => m.userId) } } });
  const roles = new Map(memberships.map((m) => [m.userId, roleNames(parseRoles(m.roles))]));
  // comment-only guests see names, not email addresses
  const full = can("project.view");
  return { members: rows.map((m) => ({ userId: m.userId, name: m.user.name, email: full ? m.user.email : "", isGuest: m.user.isGuest, external: m.user.external, disabled: m.user.disabled, roles: roles.get(m.userId) ?? (m.user.isGuest ? ["Guest reviewer"] : []) })) };
});

const Body = z
  .object({ userId: z.string().optional(), email: z.string().trim().toLowerCase().email().optional(), name: z.string().trim().max(120).optional() })
  .refine((b) => b.userId || b.email, "Select a user or enter an email address");

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Body);
  const { project, can } = await loadProject(ctx, id);
  if (!canShareProject(ctx, can("project.manage"))) throw new HttpError(403, SHARE_DENIED);
  let user = b.userId ? await db.user.findUnique({ where: { id: b.userId } }) : await db.user.findUnique({ where: { email: b.email! } });
  if (!user && b.email) {
    // pre-create the account so the invitee can sign in (Entra or guest) and find the project
    const domain = b.email.split("@")[1] ?? "";
    const internal = (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).includes(domain) || (process.env.ADMIN_EMAILS ?? "").toLowerCase().includes(`@${domain}`);
    user = await db.user.create({ data: { email: b.email, name: b.name || b.email.split("@")[0], isGuest: !internal } });
  }
  if (!user) throw new HttpError(404, "User not found");
  if (user.disabled) throw new HttpError(409, "This user is disabled");
  const existing = await db.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId: user.id } } });
  if (existing) throw new HttpError(409, `${user.email} is already a project member`);
  await db.projectMember.create({ data: { projectId: id, userId: user.id, roles: "" } });
  await audit({ workspaceId: project.workspaceId, projectId: id, actorId: ctx.user.id, type: "project.member", data: { user: user.email, action: "add" } });
  return { ok: true, userId: user.id };
});
