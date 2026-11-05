/**
 * Align and space a mixed selection: components, free texts, drawn shapes and junctions.
 *
 * Everything is placed by what you see — the symbol outline of a component, the box of a text, the
 * outline of a shape — not by insertion points, so a short text and a wide one line up on their
 * edges. Components and junctions only ever move in whole grid steps (pins stay on the 10 grid and
 * wires do not jog); texts and shapes move exactly. Wires are not arranged themselves: they follow
 * the components they connect.
 */
import type { Doc, Page, Rect, Styles } from "./model";
import type { Painter } from "./render/painter";
import { elementBounds, freeTextBounds } from "./render/scene";
import { shapeBounds } from "./shape-geom";
import { emptySel, moveSelection, type Sel } from "./ops";

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type Axis = "x" | "y";

const GRID = 10;

export type ArrangeItem = { sel: Sel; box: Rect; grid: boolean };

/** The selected things that can be aligned, each with its visible box (locked components left out). */
export function arrangeItems(doc: Doc, page: Page, sel: Sel, styles: Styles, measure: Painter["measure"]): ArrangeItem[] {
  const out: ArrangeItem[] = [];
  const els = new Set(sel.elements), ts = new Set(sel.texts), ss = new Set(sel.shapes ?? []), js = new Set(sel.junctions);
  for (const e of page.elements) {
    if (!els.has(e.id) || e.locked) continue;
    const def = doc.defs[e.defId];
    if (!def) continue;
    out.push({ sel: { ...emptySel(), elements: [e.id] }, box: elementBounds(e, def), grid: true });
  }
  for (const t of page.texts) if (ts.has(t.id)) out.push({ sel: { ...emptySel(), texts: [t.id] }, box: freeTextBounds(t, styles, measure), grid: false });
  for (const s of page.shapes) if (ss.has(s.id)) out.push({ sel: { ...emptySel(), shapes: [s.id] }, box: shapeBounds(s), grid: false });
  for (const j of page.junctions) if (js.has(j.id)) out.push({ sel: { ...emptySel(), junctions: [j.id] }, box: { x: j.x, y: j.y, w: 0, h: 0 }, grid: true });
  return out;
}

/** How many selected things align / distribute would move (for enabling the commands). */
export function arrangeCount(page: Page, sel: Sel): number {
  const els = new Set(sel.elements);
  return page.elements.filter((e) => els.has(e.id) && !e.locked).length + sel.texts.length + (sel.shapes?.length ?? 0) + sel.junctions.length;
}

const start = (b: Rect, a: Axis) => (a === "x" ? b.x : b.y);
const size = (b: Rect, a: Axis) => (a === "x" ? b.w : b.h);
const snap = (it: ArrangeItem, d: number) => (it.grid ? Math.round(d / GRID) * GRID : Math.round(d * 100) / 100);

function shift(doc: Doc, page: Page, it: ArrangeItem, axis: Axis, d: number) {
  const v = snap(it, d);
  if (v) moveSelection(doc, page, it.sel, axis === "x" ? { x: v, y: 0 } : { x: 0, y: v });
}

/**
 * The component the others line up with when aligning "to component": the first selected one
 * (locked or not — a locked component makes a good anchor). It is never moved itself.
 */
export function referenceItem(doc: Doc, page: Page, sel: Sel): ArrangeItem | null {
  for (const id of sel.elements) {
    const e = page.elements.find((x) => x.id === id);
    const def = e && doc.defs[e.defId];
    if (e && def) return { sel: { ...emptySel(), elements: [e.id] }, box: elementBounds(e, def), grid: true };
  }
  return null;
}

/** Everything that moves when aligning to `ref`: the items other than the reference itself. */
export function withoutRef(items: ArrangeItem[], ref: ArrangeItem): ArrangeItem[] {
  const id = ref.sel.elements[0];
  return items.filter((i) => i.sel.elements[0] !== id);
}

/**
 * Line the items up on the selection's left / right edge, centre line, top / bottom edge or middle —
 * or, with `ref`, on that item's edge or centre (the reference stays where it is).
 */
export function alignItems(doc: Doc, page: Page, items: ArrangeItem[], mode: AlignMode, ref?: ArrangeItem | null): number {
  if (ref) items = withoutRef(items, ref);
  if (items.length < (ref ? 1 : 2)) return 0;
  const axis: Axis = mode === "left" || mode === "center" || mode === "right" ? "x" : "y";
  const boxes = ref ? [ref.box] : items.map((i) => i.box);
  const lo = Math.min(...boxes.map((b) => start(b, axis)));
  const hi = Math.max(...boxes.map((b) => start(b, axis) + size(b, axis)));
  const edge = mode === "left" || mode === "top" ? "start" : mode === "right" || mode === "bottom" ? "end" : "mid";
  let moved = 0;
  for (const it of items) {
    const s = start(it.box, axis), z = size(it.box, axis);
    const d = edge === "start" ? lo - s : edge === "end" ? hi - (s + z) : (lo + hi) / 2 - (s + z / 2);
    if (Math.abs(snap(it, d)) > 0) moved++;
    shift(doc, page, it, axis, d);
  }
  return moved;
}

/**
 * Space the items along an axis, in their current order. Without `gap`: the first and last stay put
 * and the space between neighbours becomes equal (needs three or more). With `gap`: the first stays
 * put and each next one follows at exactly that distance (two or more).
 */
export function distributeItems(doc: Doc, page: Page, items: ArrangeItem[], axis: Axis, gap?: number): number {
  const list = [...items].sort((a, b) => start(a.box, axis) + size(a.box, axis) / 2 - (start(b.box, axis) + size(b.box, axis) / 2));
  if (list.length < (gap === undefined ? 3 : 2)) return 0;
  const first = list[0], last = list[list.length - 1];
  let g = gap ?? 0;
  if (gap === undefined) {
    const span = start(last.box, axis) + size(last.box, axis) - start(first.box, axis);
    const used = list.reduce((n, i) => n + size(i.box, axis), 0);
    g = (span - used) / (list.length - 1);
  }
  let pos = start(first.box, axis) + size(first.box, axis) + g;
  let moved = 0;
  for (const it of list.slice(1, gap === undefined ? -1 : undefined)) {
    const d = pos - start(it.box, axis);
    if (Math.abs(snap(it, d)) > 0) moved++;
    shift(doc, page, it, axis, d);
    pos += size(it.box, axis) + g;
  }
  return moved;
}

/** Centre the items on the reference component, horizontally and vertically (an x move leaves y boxes valid). */
export function centreOn(doc: Doc, page: Page, items: ArrangeItem[], ref: ArrangeItem): number {
  return alignItems(doc, page, items, "center", ref) + alignItems(doc, page, items, "middle", ref);
}
