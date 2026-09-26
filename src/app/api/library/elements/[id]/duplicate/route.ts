import { z } from "zod";
import { route, body } from "@/lib/api";
import { apiCtx } from "@/lib/session";
import { J } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertMember, loadElement, publicMeta, writableLibrary } from "@/lib/library/access";
import { createElementRecord } from "@/lib/library/store";
import { newUuid } from "@/lib/library/elmt-tools";
import { parseElmt, serializeElmt } from "@/core/qet/elmt";

export const runtime = "nodejs";

/** Duplicate into the caller's personal library (new uuid, private draft). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await apiCtx();
  assertMember(ctx);
  const { id } = await params;
  const a = await loadElement(ctx, id);
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(200).optional(), libraryId: z.string().optional() }).default({}));
  const el = a.el;
  const lib = await writableLibrary(ctx, b.libraryId);
  const name = b.name ?? `${el.name} (copy)`;
  let content = el.content;
  let uuid = newUuid();
  if (el.kind === "ELEMENT") {
    const def = parseElmt(el.content, { id: el.id });
    content = serializeElmt({ ...def, uuid, names: { ...def.names, en: name }, name });
  } else uuid = `block:${uuid}`;
  const copy = await createElementRecord({
    libraryId: lib.id,
    ownerId: ctx.user.id,
    kind: el.kind === "BLOCK" ? "BLOCK" : "ELEMENT",
    name,
    category: el.category,
    prefix: el.prefix,
    description: el.description,
    tags: J.parse<string[]>(el.tags, []),
    uuid,
    content,
    meta: { ...publicMeta(el.meta), derivedFrom: `${el.id}@${el.revision}` },
    license: el.license,
    attribution: el.attribution,
    source: el.source,
    note: `Duplicated from “${el.name}” rev ${el.revision}`,
  });
  await audit({ workspaceId: ctx.workspace.id, actorId: ctx.user.id, type: "library.duplicate", data: { id: copy.id, from: el.id, name } });
  return { id: copy.id, revision: copy.revision };
});
