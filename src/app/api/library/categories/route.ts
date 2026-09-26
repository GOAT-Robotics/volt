import type { Prisma } from "@prisma/client";
import { route } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { db } from "@/lib/db";
import { assertMember, visibleWhere } from "@/lib/library/access";

export const runtime = "nodejs";

/** Category paths with element counts for the current viewer (drives the library trees). */
export const GET = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const sp = new URL(req.url).searchParams;
  const scope = sp.get("scope") ?? "all";
  const kind = sp.get("kind");
  const libraryId = sp.get("libraryId");
  const status = sp.get("status");
  const and: Prisma.LibraryElementWhereInput[] = [visibleWhere(ctx, { adminAll: sp.get("admin") === "1" })];
  if (scope === "org") and.push({ visibility: "ORG" });
  else if (scope === "approved") and.push({ status: "APPROVED" });
  else if (scope === "mine") and.push({ ownerId: ctx.user.id });
  else if (scope === "shared") and.push({ visibility: "SHARED", shares: { some: { userId: ctx.user.id } }, NOT: { ownerId: ctx.user.id } });
  else if (scope === "pending") and.push({ status: "PENDING_APPROVAL" });
  if (kind === "ELEMENT" || kind === "BLOCK") and.push({ kind });
  if (libraryId) and.push({ libraryId });
  if (status) and.push({ status });
  const rows = await db.libraryElement.groupBy({ by: ["category"], where: { AND: and }, _count: { _all: true }, orderBy: { category: "asc" } });
  const total = rows.reduce((a, r) => a + r._count._all, 0);
  return { total, categories: rows.map((r) => ({ path: r.category, count: r._count._all })) };
});
