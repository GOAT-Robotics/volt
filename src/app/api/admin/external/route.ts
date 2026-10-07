import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { assertRole, listExternal, roleTokenFor, setProjects } from "@/lib/external";
import { createLoginLink, mailLoginLink } from "@/lib/magiclink";
import { mailConfigured } from "@/lib/mail";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  return { users: await listExternal(ctx.workspace.id), mail: mailConfigured() };
});

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().max(120).default(""),
  roleId: z.string().min(1),
  projectIds: z.array(z.string()).min(1, "Assign at least one project").max(200),
  accessUntil: z.string().datetime().nullable().optional(),
  send: z.boolean().default(true),
});

/** Creates an external partner, assigns the role and projects, and emails (or returns) an invitation link. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, Body);
  const role = await assertRole(ctx.workspace.id, b.roleId);
  const until = b.accessUntil ? new Date(b.accessUntil) : null;
  if (until && until.getTime() < Date.now()) throw new HttpError(400, "The access end date is in the past");
  let user = await db.user.findUnique({ where: { email: b.email } });
  if (user && !user.external) throw new HttpError(409, `${b.email} is an organization account — add them to projects as a member instead`);
  if (user && (await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ctx.workspace.id, userId: user.id } } }))) throw new HttpError(409, `${b.email} is already an external user here`);
  user = user
    ? await db.user.update({ where: { id: user.id }, data: { name: b.name, company: b.company, accessUntil: until, disabled: false } })
    : await db.user.create({ data: { email: b.email, name: b.name, company: b.company, external: true, accessUntil: until } });
  await db.membership.create({ data: { workspaceId: ctx.workspace.id, userId: user.id, roles: roleTokenFor(role.id), source: "EXTERNAL" } });
  const pr = await setProjects(ctx.workspace.id, user.id, b.projectIds);
  const link = await createLoginLink(user.id, "invite", ctx.user.id, req);
  const mailed = b.send && (await mailLoginLink(user, link.url, link.expiresAt, { workspace: ctx.workspace.name, invitedBy: ctx.user.name, projects: pr.names }));
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.external", data: { action: "create", user: user.email, company: b.company, role: role.name, projects: pr.names, accessUntil: until?.toISOString() ?? null, invite: mailed ? "emailed" : "link shown to admin" } });
  // the link is only shown when it could not be emailed (the admin passes it on)
  return { ok: true, userId: user.id, mailed, link: mailed ? null : link.url, expiresAt: link.expiresAt.toISOString() };
});
