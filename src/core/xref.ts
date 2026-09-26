/**
 * Cross references: every clickable "label" in a project and where it leads.
 *
 * A label is
 *  - a component reference (K1 on the coil ↔ K1 on its contacts, on any page),
 *  - a wire label / wire number (the same number drawn on several wires or pages),
 *  - a QElectroTech folio report arrow or master/slave element linked by <links_uuids>.
 *
 * Occurrences that belong together form a group (union of explicit QET links, equal component
 * references and equal wire labels). Following a label goes to the next member of its group, in
 * reading order (page → column → row). Used by the editor (⌘/Ctrl-click, or plain click on
 * read-only versions) and by PDF export (internal link annotations).
 */
import type { Doc, ElemInst, Page, Pt, Rect, Styles } from "./model";
import { docStyles, elementBounds, layoutElementTexts, pageGeometry, textBounds } from "./render/scene";
import { symbolFor, PT } from "./render/symbol";
import { pointAlong, unionRect } from "./geometry";
import type { Painter } from "./render/painter";

export type XrefKind = "component" | "wire" | "report" | "link";

export type Occurrence = {
  idx: number;
  kind: XrefKind;
  text: string;
  pageId: string;
  /** element or wire id */
  id: string;
  /** the label text box (scene coordinates) */
  rect: Rect;
  /** extra clickable areas (e.g. the symbol of a folio report arrow) */
  hit: Rect[];
  /** point to center on when this occurrence is the destination */
  at: Pt;
  group: number;
};

export type Xref = {
  occ: Occurrence[];
  groups: number[][]; // group -> occurrence indices in reading order
  byPage: Map<string, Occurrence[]>;
};

class DSU {
  p: number[] = [];
  add() {
    this.p.push(this.p.length);
    return this.p.length - 1;
  }
  find(a: number): number {
    while (this.p[a] !== a) a = this.p[a] = this.p[this.p[a]];
    return a;
  }
  union(a: number, b: number) {
    const x = this.find(a), y = this.find(b);
    if (x !== y) this.p[x] = y;
  }
}

const isReport = (lt: string) => lt === "next_report" || lt === "previous_report";

export function buildXref(doc: Doc, measure: Painter["measure"], styles: Styles = docStyles(doc)): Xref {
  const pages = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const occ: Occurrence[] = [];
  const dsu = new DSU();
  const byElement = new Map<string, number>();
  const byLabel = new Map<string, number>();
  const byWireLabel = new Map<string, number>();
  const pageIndex = new Map(pages.map((p, i) => [p.id, i]));

  for (const page of pages) {
    for (const e of page.elements) {
      const def = doc.defs[e.defId];
      if (!def || def.name === "volt_junction" || e.hidden) continue;
      const label = (e.info.label ?? "").trim();
      const report = isReport(def.linkType);
      const linked = !!e.links?.length;
      if (!label && !linked) continue;
      const body = elementBounds(e, def);
      const rect = labelRect(e, page, doc, styles, measure) ?? body;
      const kind: XrefKind = report ? "report" : linked ? "link" : "component";
      const i = dsu.add();
      occ.push({ idx: i, kind, text: label || def.name, pageId: page.id, id: e.id, rect, hit: [rect, ...(report ? [body] : [])], at: center(unionRect(rect, body)), group: -1 });
      byElement.set(e.id, i);
      if (label && !report) {
        const k = label.toLowerCase();
        const prev = byLabel.get(k);
        if (prev === undefined) byLabel.set(k, i);
        else dsu.union(prev, i);
      }
    }
    for (const w of page.wires) {
      const text = (w.label ?? "").trim();
      if (!text || w.pts.length < 2) continue;
      const st = styles.text.wireLabel;
      const size = st.size * PT;
      const { p, horizontal } = pointAlong(w.pts, w.labelPos ?? 0.5);
      const tw = measure(text, size, st.font, st.weight);
      const h = size * st.lineHeight;
      const rect = horizontal ? { x: p.x - tw / 2 + st.dx - 1, y: p.y - h - 1 + st.dy, w: tw + 2, h: h + 1 } : { x: p.x - h - 1 + st.dx, y: p.y - tw / 2 + st.dy - 1, w: h + 1, h: tw + 2 };
      const i = dsu.add();
      occ.push({ idx: i, kind: "wire", text, pageId: page.id, id: w.id, rect, hit: [rect], at: p, group: -1 });
      const k = text.toLowerCase();
      const prev = byWireLabel.get(k);
      if (prev === undefined) byWireLabel.set(k, i);
      else dsu.union(prev, i);
    }
  }
  // explicit QElectroTech links (folio reports, master ↔ slaves)
  for (const page of pages)
    for (const e of page.elements) {
      const a = byElement.get(e.id);
      if (a === undefined || !e.links) continue;
      for (const l of e.links) {
        const b = byElement.get(l);
        if (b !== undefined) dsu.union(a, b);
      }
    }

  const gmap = new Map<number, number[]>();
  for (const o of occ) {
    const r = dsu.find(o.idx);
    const g = gmap.get(r) ?? [];
    g.push(o.idx);
    gmap.set(r, g);
  }
  const groups: number[][] = [];
  const order = (i: number) => {
    const o = occ[i];
    return [pageIndex.get(o.pageId) ?? 0, Math.round(o.at.x / 20), o.at.y] as const;
  };
  for (const g of gmap.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => {
      const A = order(a), B = order(b);
      return A[0] - B[0] || A[1] - B[1] || A[2] - B[2];
    });
    const gi = groups.length;
    groups.push(g);
    for (const i of g) occ[i].group = gi;
  }
  const byPage = new Map<string, Occurrence[]>();
  for (const o of occ) {
    if (o.group < 0) continue;
    const arr = byPage.get(o.pageId) ?? [];
    arr.push(o);
    byPage.set(o.pageId, arr);
  }
  return { occ, groups, byPage };
}

/** All other members of an occurrence's group, starting with the next one in reading order. */
export function targetsOf(x: Xref, o: Occurrence): Occurrence[] {
  if (o.group < 0) return [];
  const g = x.groups[o.group];
  const i = g.indexOf(o.idx);
  const out: Occurrence[] = [];
  for (let k = 1; k < g.length; k++) out.push(x.occ[g[(i + k) % g.length]]);
  return out;
}

/** Occurrence under a scene point on a page (smallest hit area wins). */
export function occurrenceAt(x: Xref, pageId: string, p: Pt, tol = 0): Occurrence | null {
  let best: { o: Occurrence; a: number } | null = null;
  for (const o of x.byPage.get(pageId) ?? [])
    for (const r of o.hit) {
      if (p.x < r.x - tol || p.x > r.x + r.w + tol || p.y < r.y - tol || p.y > r.y + r.h + tol) continue;
      const a = r.w * r.h;
      if (!best || a < best.a) best = { o, a };
    }
  return best?.o ?? null;
}

/** Drawing-frame grid reference like "5C" (column number + row letter), QElectroTech style. */
export function gridRef(doc: Doc, page: Page, p: Pt): string {
  const b = page.border;
  const hx = b.showRows ? b.headerW : 0, hy = b.showCols ? b.headerH : 0;
  const col = Math.floor((p.x - hx) / b.colW) + 1;
  const row = Math.floor((p.y - hy) / b.rowH);
  const g = pageGeometry(doc, page).border;
  if (p.x < 0 || p.y < 0 || p.x > g.w || p.y > g.h || col < 1 || row < 0) return "";
  return `${col}${String.fromCharCode(65 + (row % 26))}`;
}

export function describe(doc: Doc, o: Occurrence): string {
  const pages = [...doc.pages].sort((a, b) => a.order - b.order);
  const pi = pages.findIndex((p) => p.id === o.pageId);
  const page = pages[pi];
  const ref = page ? gridRef(doc, page, o.at) : "";
  return `${o.text} · page ${pi + 1}${page ? ` “${page.title}”` : ""}${ref ? ` · ${ref}` : ""}`;
}

function labelRect(e: ElemInst, page: Page, doc: Doc, styles: Styles, measure: Painter["measure"]): Rect | null {
  const def = doc.defs[e.defId];
  const sym = symbolFor(def);
  const label = e.info.label ?? "";
  const texts = e.texts.filter((t) => t.info === "label" || t.info === "formula");
  const laid = texts.length ? layoutElementTexts({ ...e, texts }, sym, styles, measure) : e.texts.length ? [] : layoutElementTexts(e, sym, styles, measure).filter((t) => t.text === label);
  let r: Rect | null = null;
  for (const t of laid) r = unionRect(r, textBounds(t));
  void page;
  return r;
}

const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Cached per document object. */
const cache = new WeakMap<Doc, { key: string; x: Xref }>();
export function cachedXref(doc: Doc, measure: Painter["measure"], key = "canvas"): Xref {
  const c = cache.get(doc);
  if (c && c.key === key) return c.x;
  const x = buildXref(doc, measure);
  cache.set(doc, { key, x });
  return x;
}
