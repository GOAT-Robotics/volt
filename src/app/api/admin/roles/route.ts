import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { loadCustomRoles } from "@/lib/customroles";
import { cleanActions } from "@/lib/external";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const rows = await db.customRole.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { name: "asc" } });
  return { roles: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, actions: r.actions.split(",").filter(Boolean) })) };
});

const Body = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(300).default(""), actions: z.array(z.string()).max(30) });

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, Body);
  const actions = cleanActions(b.actions);
  if (!actions.includes("project.view")) throw new HttpError(400, "A role must at least open its assigned projects");
  if (await db.customRole.findFirst({ where: { workspaceId: ctx.workspace.id, name: b.name } })) throw new HttpError(409, `A role named “${b.name}” already exists`);
  const r = await db.customRole.create({ data: { workspaceId: ctx.workspace.id, name: b.name, description: b.description, actions: actions.join(",") } });
  await loadCustomRoles(true);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "admin.role", data: { action: "create", role: r.name, actions: r.actions } });
  return { ok: true, id: r.id };
});
