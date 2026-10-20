/**
 * Page operations shared by the editor and the MCP server: order, duplicate, move.
 * Mutate the given (immer draft) document in place.
 */
import type { Doc } from "./model";
import { uid } from "./ids";

export function reorderPages(d: Doc, id: string, dir: -1 | 1) {
  const pages = [...d.pages].sort((a, b) => a.order - b.order);
  const i = pages.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  pages.forEach((p, k) => {
    const dp = d.pages.find((x) => x.id === p.id)!;
    dp.order = k;
  });
}

export function duplicatePage(d: Doc, id: string): string {
  const src = d.pages.find((p) => p.id === id);
  if (!src) return id;
  const copy = JSON.parse(JSON.stringify(src)) as typeof src;
  const map = new Map<string, string>();
  copy.id = uid();
  copy.title = src.title + " (copy)";
  copy.qet = undefined;
  for (const e of copy.elements) {
    const n = uid();
    map.set(e.id, n);
    e.id = n;
    e.qet = undefined;
  }
  for (const j of copy.junctions) {
    const n = uid();
    map.set(j.id, n);
    j.id = n;
  }
  for (const w of copy.wires) {
    w.id = uid();
    w.qet = undefined;
    for (const k of ["a", "b"] as const) {
      const e = w[k];
      if (e.k === "pin") e.el = map.get(e.el) ?? e.el;
      if (e.k === "junction") e.j = map.get(e.j) ?? e.j;
    }
  }
  for (const t of copy.texts) (t.id = uid()), (t.qet = undefined);
  for (const sh of copy.shapes) (sh.id = uid()), (sh.qet = undefined);
  // mates and cross-references stay with the original unless both ends are on the copied page
  for (const e of copy.elements) {
    if (e.mate) {
      const m = map.get(e.mate.id);
      if (m) e.mate = { ...e.mate, id: m };
      else delete e.mate;
    }
    if (e.links) {
      const l = e.links.map((x) => map.get(x)).filter((x): x is string => !!x);
      if (l.length) e.links = l;
      else delete e.links;
    }
  }
  for (const p of d.pages) if (p.order > src.order) p.order++;
  copy.order = src.order + 1;
  d.pages.push(copy);
  return copy.id;
}

/** move a page to a position (1-based, among the pages that are not archived) */
export function movePageTo(d: Doc, id: string, position: number) {
  const pages = [...d.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const i = pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = pages.splice(i, 1);
  pages.splice(Math.max(0, Math.min(pages.length, position - 1)), 0, p);
  const archived = [...d.pages].filter((x) => x.archived).sort((a, b) => a.order - b.order);
  [...pages, ...archived].forEach((x, k) => (d.pages.find((q) => q.id === x.id)!.order = k));
}
