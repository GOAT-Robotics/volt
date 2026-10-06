import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError, loadProject } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  customer: z.string().trim().max(200).optional(),
  description: z.string().max(10_000).optional(),
  state: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

/** rename / describe a variant (designers), archive or restore it (project owners) */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  const { id } = await params;
  const b = await body(req, Patch);
  const v = await db.variant.findUnique({ where: { id } });
  if (!v) throw new HttpError(404, "Variant not found");
  const { project, can } = await loadProject(ctx, v.projectId);
  if (b.state && b.state !== v.state && !can("project.manage")) throw new HttpError(403, "Only project owners can archive or restore variants");
  if (!can("project.edit") && !can("project.manage")) throw new HttpError(403, "You cannot change variants in this project");
  if (b.state === "ARCHIVED") {
    const open = await db.version.findFirst({ where: { variantId: id, status: { in: ["IN_REVIEW", "APPROVED"] } } });
    if (open) throw new HttpError(409, `Version ${open.label} of this variant is ${open.status.toLowerCase().replace("_", " ")} — finish or withdraw it first`);
  }
  const u = await db.variant.update({ where: { id }, data: b });
  await audit({ workspaceId: project.workspaceId, projectId: project.id, actorId: ctx.user.id, type: "variant.update", data: { code: u.code, name: u.name, ...(b.state ? { state: b.state } : {}) } });
  return { ok: true };
});
