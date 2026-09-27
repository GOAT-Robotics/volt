import { rateLimit } from "@/lib/ratelimit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { body, route } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { accessFor, assertMember, visibleWhere } from "@/lib/library/access";
import { buildZip } from "@/lib/library/store";

export const runtime = "nodejs";

const Q = z.object({ ids: z.array(z.string()).max(5000).optional(), libraryId: z.string().optional(), category: z.string().optional(), name: z.string().max(80).optional() });

async function exportZip(ctx: Awaited<ReturnType<typeof apiCtx>>, q: z.infer<typeof Q>) {
  if (!q.ids?.length && !q.libraryId) throw new HttpError(400, "Choose elements or a library to export");
  const and: Prisma.LibraryElementWhereInput[] = [visibleWhere(ctx), { kind: "ELEMENT" }];
  if (q.ids?.length) and.push({ id: { in: q.ids } });
  if (q.libraryId) and.push({ libraryId: q.libraryId });
  if (q.category) and.push({ OR: [{ category: q.category }, { category: { startsWith: q.category + "/" } }] });
  const rows = await db.libraryElement.findMany({ where: { AND: and }, include: { library: true, shares: { select: { userId: true, canEdit: true } } }, orderBy: [{ category: "asc" }, { name: "asc" }] });
  if (!rows.length) throw new HttpError(404, "Nothing to export");
  // plain org viewers get the approved revision (one query for all of them)
  const pinned = rows.map((r) => ({ r, rev: accessFor(ctx, r).viewerRevision })).filter((x) => x.rev !== x.r.revision);
  const revs = new Map<string, string>();
  for (let i = 0; i < pinned.length; i += 300) {
    const chunk = pinned.slice(i, i + 300);
    for (const x of await db.libraryElementRevision.findMany({ where: { OR: chunk.map((p) => ({ elementId: p.r.id, revision: p.rev })) }, select: { elementId: true, content: true } })) revs.set(x.elementId, x.content);
  }
  const items = rows.map((r) => (revs.has(r.id) ? { ...r, content: revs.get(r.id)! } : r));
  const lib = q.libraryId ? rows[0].library.name : q.name || "volt_library";
  const zip = buildZip(items, lib);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.export", data: { ids: items.map((i) => i.id).slice(0, 200), count: items.length, libraryId: q.libraryId ?? null, format: "zip" } });
  const fn = `${lib.replace(/[^\w.-]+/g, "_")}.zip`;
  return new Response(zip as unknown as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${fn}"`, "cache-control": "no-store" } });
}

/** GET ?ids=a,b | ?libraryId=… [&category=…] */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  rateLimit(`library.export:${ctx.user.id}`, 10);
  assertMember(ctx);
  const sp = new URL(req.url).searchParams;
  return exportZip(ctx, Q.parse({ ids: sp.get("ids")?.split(",").filter(Boolean), libraryId: sp.get("libraryId") ?? undefined, category: sp.get("category") ?? undefined, name: sp.get("name") ?? undefined }));
});

/** POST { ids } for large selections */
export const POST = route(async (req) => {
  const ctx = await apiCtx();
  rateLimit(`library.export:${ctx.user.id}`, 10);
  assertMember(ctx);
  return exportZip(ctx, Q.parse(await body(req, z.unknown()).catch(() => ({}))));
});
