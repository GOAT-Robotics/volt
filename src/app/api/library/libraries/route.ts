import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertMember, canManageLibrary, canWriteLibrary, isAdmin, isApprover, librariesWhere, personalLibrary, visibleWhere } from "@/lib/library/access";

export const runtime = "nodejs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  assertMember(ctx);
  await personalLibrary(ctx);
  const libs = await db.library.findMany({ where: librariesWhere(ctx), orderBy: [{ scope: "asc" }, { name: "asc" }] });
  const counts = await db.libraryElement.groupBy({ by: ["libraryId"], where: { AND: [visibleWhere(ctx), { libraryId: { in: libs.map((l) => l.id) } }] }, _count: { _all: true } });
  const owners = await db.user.findMany({ where: { id: { in: libs.map((l) => l.ownerId ?? "").filter(Boolean) } }, select: { id: true, name: true } });
  return {
    libraries: libs.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      scope: l.scope,
      source: l.source,
      license: l.license,
      attribution: l.attribution,
      ownerId: l.ownerId,
      ownerName: owners.find((o) => o.id === l.ownerId)?.name ?? null,
      createdAt: l.createdAt,
      count: counts.find((c) => c.libraryId === l.id)?._count._all ?? 0,
      mine: l.ownerId === ctx.user.id && l.scope === "PERSONAL",
      canWrite: canWriteLibrary(ctx, l),
      canManage: canManageLibrary(ctx, l),
    })),
    canCreateOrg: isAdmin(ctx) || isApprover(ctx),
  };
});

const LibBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  scope: z.enum(["PERSONAL", "SHARED", "ORG"]).default("PERSONAL"),
  source: z.string().max(1000).nullable().optional(),
  license: z.string().max(400).nullable().optional(),
  attribution: z.string().max(1000).nullable().optional(),
});

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const b = await body(req, LibBody);
  if (b.scope === "ORG" && !isAdmin(ctx) && !isApprover(ctx)) throw new HttpError(403, "Only administrators and library approvers can create organization libraries");
  const lib = await db.library.create({ data: { workspaceId: ctx.workspace.id, ownerId: ctx.user.id, name: b.name, description: b.description, scope: b.scope, source: b.source || null, license: b.license || null, attribution: b.attribution || null } });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.lib.create", data: { id: lib.id, name: lib.name, scope: lib.scope } });
  return { id: lib.id };
});
