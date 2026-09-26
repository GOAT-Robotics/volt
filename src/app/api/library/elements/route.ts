import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { route, body } from "@/lib/api";
import { apiCtx, HttpError } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertMember, publishToOrg, tagsIn, toLibItem, visibleWhere, writableLibrary, LIB_STATUSES } from "@/lib/library/access";
import { checkElmt, createElementRecord } from "@/lib/library/store";
import { guessPrefix, newUuid, normCategory } from "@/lib/library/elmt-tools";
import { serializeElmt } from "@/core/qet/elmt";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") ?? "").trim();
  const scope = sp.get("scope") ?? "all";
  const kind = sp.get("kind");
  const status = sp.get("status");
  const libraryId = sp.get("libraryId");
  const category = sp.get("category");
  const tag = sp.get("tag");
  const idsParam = sp.get("ids");
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 200, 1), 3000);

  const and: Prisma.LibraryElementWhereInput[] = [visibleWhere(ctx, { adminAll: sp.get("admin") === "1", includeDeprecated: status === "DEPRECATED" || sp.get("deprecated") === "1" })];
  if (scope === "org") and.push({ visibility: "ORG" });
  else if (scope === "approved") and.push({ status: "APPROVED" });
  else if (scope === "mine") and.push({ ownerId: ctx.user.id });
  else if (scope === "shared") and.push({ visibility: "SHARED", shares: { some: { userId: ctx.user.id } }, NOT: { ownerId: ctx.user.id } });
  else if (scope === "pending") and.push({ status: "PENDING_APPROVAL" });
  if (kind === "ELEMENT" || kind === "BLOCK") and.push({ kind });
  if (status && (LIB_STATUSES as string[]).includes(status)) and.push({ status });
  if (libraryId) and.push({ libraryId });
  if (category) {
    const c = normCategory(category);
    and.push({ OR: [{ category: c }, { category: { startsWith: c + "/" } }] });
  }
  if (tag) and.push({ tags: { contains: JSON.stringify(tag).slice(0, -1) } });
  if (idsParam) and.push({ id: { in: idsParam.split(",").filter(Boolean).slice(0, 500) } });
  for (const term of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
    and.push({
      OR: [
        { name: { contains: term } },
        { tags: { contains: term } },
        { prefix: { contains: term } },
        { category: { contains: term } },
        { description: { contains: term } },
        { meta: { contains: term } },
      ],
    });
  }
  const rows = await db.libraryElement.findMany({
    where: { AND: and },
    include: { library: true, shares: { select: { userId: true, canEdit: true } } },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    take: limit,
    omit: { content: true },
  });
  const owners = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } }, select: { id: true, name: true } });
  const names = new Map(owners.map((u) => [u.id, u.name]));
  return { items: rows.map((r) => toLibItem(ctx, { ...r, content: "" }, names.get(r.ownerId))), limit, truncated: rows.length === limit };
});

const Create = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().max(400).default(""),
  prefix: z.string().max(16).default(""),
  visibility: z.enum(["PRIVATE", "SHARED", "ORG"]).default("PRIVATE"),
  content: z.string().min(10).max(5_000_000),
  description: z.string().max(4000).default(""),
  tags: z.array(z.string()).optional(),
  libraryId: z.string().optional().nullable(),
  meta: z.record(z.string(), z.string()).optional(),
  license: z.string().max(400).optional().nullable(),
  attribution: z.string().max(1000).optional().nullable(),
  source: z.string().max(1000).optional().nullable(),
  note: z.string().max(500).optional(),
});

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const b = await body(req, Create);
  let def;
  try {
    def = checkElmt(b.content, b.name);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  let content = b.content;
  let uuid = def.uuid;
  // a uuid already used in this workspace → give the new element its own identity
  const clash = uuid ? await db.libraryElement.findFirst({ where: { uuid, library: { workspaceId: ctx.workspace.id } }, select: { id: true } }) : null;
  if (!uuid || clash) {
    uuid = newUuid();
    content = serializeElmt({ ...def, uuid });
  }
  const lib = await writableLibrary(ctx, b.libraryId);
  const category = normCategory(b.category || def.category);
  const el = await createElementRecord({
    libraryId: lib.id,
    ownerId: ctx.user.id,
    name: b.name,
    category,
    prefix: b.prefix || def.prefix || guessPrefix({ ...def, category }),
    description: b.description,
    tags: tagsIn(b.tags ?? []),
    uuid,
    content,
    meta: b.meta ?? {},
    visibility: b.visibility === "SHARED" ? "SHARED" : "PRIVATE",
    license: b.license ?? lib.license,
    attribution: b.attribution ?? lib.attribution,
    source: b.source ?? null,
    note: b.note ?? "Created",
  });
  let status = el.status;
  if (b.visibility === "ORG") status = await publishToOrg(ctx, el);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.create", data: { id: el.id, name: el.name, kind: "ELEMENT", visibility: b.visibility, status } });
  return { id: el.id, revision: el.revision, status };
});
