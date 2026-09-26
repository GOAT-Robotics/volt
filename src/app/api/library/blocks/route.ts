import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { audit } from "@/lib/audit";
import { assertMember, publishToOrg, tagsIn, writableLibrary } from "@/lib/library/access";
import { createElementRecord } from "@/lib/library/store";
import { newUuid, normCategory } from "@/lib/library/elmt-tools";

export const runtime = "nodejs";

const BlockContentSchema = z
  .object({
    defs: z.record(z.string(), z.unknown()),
    elements: z.array(z.unknown()),
    wires: z.array(z.unknown()),
    junctions: z.array(z.unknown()).default([]),
    texts: z.array(z.unknown()).default([]),
    ports: z.array(z.object({ name: z.string(), x: z.number(), y: z.number(), el: z.string().optional(), pin: z.string().optional() })).default([]),
    bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  })
  .passthrough();

const Create = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  category: z.string().max(400).default("Blocks"),
  visibility: z.enum(["PRIVATE", "SHARED", "ORG"]).default("PRIVATE"),
  content: BlockContentSchema,
  tags: z.array(z.string()).optional(),
  libraryId: z.string().optional().nullable(),
});

export const POST = route(async (req) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const b = await body(req, Create);
  const lib = await writableLibrary(ctx, b.libraryId);
  const el = await createElementRecord({
    libraryId: lib.id,
    ownerId: ctx.user.id,
    kind: "BLOCK",
    name: b.name,
    category: normCategory(b.category),
    description: b.description,
    tags: tagsIn(b.tags ?? []),
    uuid: `block:${newUuid()}`,
    content: JSON.stringify(b.content),
    visibility: b.visibility === "SHARED" ? "SHARED" : "PRIVATE",
    note: "Created",
  });
  let status = el.status;
  if (b.visibility === "ORG") status = await publishToOrg(ctx, el);
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.create", data: { id: el.id, name: el.name, kind: "BLOCK", visibility: b.visibility, status } });
  return { id: el.id, revision: el.revision, status };
});
