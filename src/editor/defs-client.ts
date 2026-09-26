"use client";
import type { ElementDef } from "@/core/model";
import { parseElmt } from "@/core/qet/elmt";

export type LibItem = {
  id: string;
  kind: "ELEMENT" | "BLOCK";
  name: string;
  category: string;
  prefix: string;
  tags: string[];
  visibility: "PRIVATE" | "SHARED" | "ORG";
  status: string;
  revision: number;
  ownerName?: string;
  libraryName?: string;
  updatedAt?: string;
  description?: string;
};

const cache = new Map<string, Promise<ElementDef>>();

/** Library element id → ElementDef (cached per revision). */
export function libDefId(id: string, rev: number) {
  return `lib:${id}@${rev}`;
}

export async function loadLibraryDef(item: Pick<LibItem, "id" | "revision" | "category" | "status">): Promise<ElementDef> {
  const key = libDefId(item.id, item.revision);
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/api/library/elements/${item.id}?rev=${item.revision}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load element");
        return r.json();
      })
      .then((j: { content: string; revision: number; category: string; status: string; meta?: Record<string, string>; prefix?: string }) => {
        const def = parseElmt(j.content, { id: key, category: j.category });
        def.id = key;
        def.source = { libraryElementId: item.id, revision: j.revision, status: j.status };
        if (j.prefix && !def.prefix) def.prefix = j.prefix;
        if (j.meta) def.meta = { ...def.meta, ...j.meta };
        return def;
      });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
