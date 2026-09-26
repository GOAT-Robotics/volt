import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db, J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/access";
import { defaultStyles } from "@/core/styles";
import { parseHistory, pushHistory, normalizeStyles } from "@/lib/styletemplates";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const rows = await db.styleTemplate.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  return { templates: rows.map((t) => ({ id: t.id, name: t.name, version: t.version, status: t.status, isDefault: t.isDefault, updatedAt: t.updatedAt.toISOString(), styles: normalizeStyles(J.parse(t.styles, {})), history: parseHistory(t.history).map(({ styles: _s, ...h }) => h) })) };
});

/** Create from built-in defaults or by copying an existing template. */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertAdmin(ctx);
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(120), fromId: z.string().nullish() }));
  let styles: unknown = defaultStyles();
  if (b.fromId) {
    const src = await db.styleTemplate.findFirst({ where: { id: b.fromId, workspaceId: ctx.workspace.id } });
    if (!src) throw new HttpError(404, "Source template not found");
    styles = normalizeStyles(J.parse(src.styles, {}));
  }
  const t = await db.styleTemplate.create({
    data: { workspaceId: ctx.workspace.id, name: b.name, styles: JSON.stringify(styles), ownerId: ctx.user.id, history: pushHistory("[]", { version: 1, action: b.fromId ? "copy" : "create", at: new Date().toISOString(), by: ctx.user.name, name: b.name }) },
  });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "style.update", data: { action: "create", name: b.name, templateId: t.id } });
  return { id: t.id };
});
