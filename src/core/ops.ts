/**
 * Document mutations. All functions mutate the given (immer draft) objects in place and are
 * deterministic, so they are safe to use inside produceWithPatches for undo/redo.
 */
import type { Doc, ElemInst, ElementDef, FreeText, Junction, Page, Pt, Wire, WireEnd } from "./model";
import { eqPt, GRID_ORIGIN, rotOrient, toScene } from "./geometry";
import { uid } from "./ids";
import { endPoint, wiresOfElement } from "./topology";
import { moveEndpoint, nearestSegment, simplify, splitAt, translatePts } from "./wires";
import { nextRef } from "./numbering";

export type Sel = { elements: string[]; wires: string[]; junctions: string[]; texts: string[] };
export const emptySel = (): Sel => ({ elements: [], wires: [], junctions: [], texts: [] });
export const selSize = (s: Sel) => s.elements.length + s.wires.length + s.junctions.length + s.texts.length;

export function getPage(doc: Doc, id: string): Page {
  const p = doc.pages.find((x) => x.id === id);
  if (!p) throw new Error("page not found");
  return p;
}

/* ------------------------------------------------------------------ */
/* Elements                                                             */
/* ------------------------------------------------------------------ */

export function ensureDef(doc: Doc, def: ElementDef) {
  if (!doc.defs[def.id]) doc.defs[def.id] = def;
}

export function newElement(doc: Doc, page: Page, def: ElementDef, at: Pt, rot: 0 | 1 | 2 | 3 = 0, mirror = false): ElemInst {
  ensureDef(doc, def);
  const e: ElemInst = {
    id: uid(),
    defId: def.id,
    x: at.x,
    y: at.y,
    rot,
    mirror,
    info: { ...Object.fromEntries(Object.entries(def.info).filter(([k]) => k !== "label")) },
    texts: [],
  };
  // instantiate definition dynamic texts so positions can be edited per instance
  for (const p of def.prims) {
    if (p.t !== "dyntext") continue;
    const role = p.info === "label" || p.info === "formula" ? "componentRef" : p.info === "comment" || p.info === "description" ? "componentName" : "annotation";
    e.texts.push({ id: uid(), role, info: p.from === "ElementInfo" ? p.info ?? "label" : null, text: p.text, x: p.x, y: p.y, uuid: p.uuid });
  }
  if (!e.texts.some((t) => t.info === "label") && def.pins.length > 0) e.texts.push({ id: uid(), role: "componentRef", info: "label", text: "", x: null, y: null });
  if (doc.numbering.autoOnPlace) {
    const ref = nextRef(doc, page, e);
    if (ref) e.info.label = ref;
  }
  page.elements.push(e);
  return e;
}

/** Recompute endpoint geometry of every wire attached to the given elements / junctions. */
export function refreshAttached(doc: Doc, page: Page, elIds: Set<string>, jIds: Set<string> = new Set()) {
  const idx = new Map(page.elements.map((e) => [e.id, e]));
  for (const w of page.wires) {
    for (const end of ["a", "b"] as const) {
      const we = w[end];
      const hit = (we.k === "pin" && elIds.has(we.el)) || (we.k === "junction" && jIds.has(we.j));
      if (!hit) continue;
      const p = endPoint(doc, page, we, idx);
      if (!p) continue;
      const cur = end === "a" ? w.pts[0] : w.pts[w.pts.length - 1];
      if (!eqPt(cur, p)) w.pts = moveEndpoint(w.pts, end, p);
    }
  }
}

/**
 * Move a selection. Fully selected wires translate; wires with one attached end rubber-band.
 */
export function moveSelection(doc: Doc, page: Page, sel: Sel, d: Pt) {
  if (!d.x && !d.y) return;
  const els = new Set(sel.elements), js = new Set(sel.junctions), ws = new Set(sel.wires), ts = new Set(sel.texts);
  for (const e of page.elements) if (els.has(e.id) && !e.locked) (e.x += d.x), (e.y += d.y);
  for (const j of page.junctions) if (js.has(j.id)) (j.x += d.x), (j.y += d.y);
  for (const t of page.texts) if (ts.has(t.id)) (t.x += d.x), (t.y += d.y);
  const movedEnd = (we: WireEnd) => (we.k === "pin" && els.has(we.el)) || (we.k === "junction" && js.has(we.j));
  for (const w of page.wires) {
    const ma = movedEnd(w.a), mb = movedEnd(w.b);
    const whole = ws.has(w.id) || (ma && mb);
    if (whole) {
      // a selected wire whose ends are attached to *unselected* things only moves its interior
      const fixedA = !ma && w.a.k !== "free", fixedB = !mb && w.b.k !== "free";
      if (!fixedA && !fixedB) w.pts = translatePts(w.pts, d);
      else if (w.pts.length > 2) {
        const inner = translatePts(w.pts.slice(1, -1), d);
        w.pts = simplify([w.pts[0], ...inner, w.pts[w.pts.length - 1]]);
        // restore orthogonality at fixed ends
        if (fixedA) w.pts = moveEndpoint(w.pts, "a", w.pts[0]);
        if (fixedB) w.pts = moveEndpoint(w.pts, "b", w.pts[w.pts.length - 1]);
      }
    }
  }
  refreshAttached(doc, page, els, js);
}

export function rotateSelection(doc: Doc, page: Page, sel: Sel, cw = true, pivot?: Pt) {
  const els = page.elements.filter((e) => sel.elements.includes(e.id) && !e.locked);
  if (!els.length && !sel.texts.length) return;
  const c = pivot ?? (els.length === 1 ? { x: els[0].x, y: els[0].y } : rotationPivot(doc, els));
  const rot = (p: Pt): Pt => {
    const dx = p.x - c.x, dy = p.y - c.y;
    return cw ? { x: c.x - dy, y: c.y + dx } : { x: c.x + dy, y: c.y - dx };
  };
  for (const e of els) {
    const p = rot(e);
    e.x = Math.round(p.x);
    e.y = Math.round(p.y);
    e.rot = (((e.rot + (cw ? 1 : 3)) % 4) as 0 | 1 | 2 | 3);
  }
  const js = page.junctions.filter((j) => sel.junctions.includes(j.id));
  for (const j of js) {
    const p = rot(j);
    j.x = Math.round(p.x);
    j.y = Math.round(p.y);
  }
  for (const w of page.wires) if (sel.wires.includes(w.id) && w.a.k === "free" && w.b.k === "free") w.pts = w.pts.map(rot);
  refreshAttached(doc, page, new Set(els.map((e) => e.id)), new Set(js.map((j) => j.id)));
}

export function mirrorSelection(doc: Doc, page: Page, sel: Sel) {
  const els = page.elements.filter((e) => sel.elements.includes(e.id) && !e.locked);
  // mirror about the centre of the hotspots' bbox: it is invariant under the flip, so X twice is an exact identity
  const minX = Math.min(...els.map((e) => e.x)), maxX = Math.max(...els.map((e) => e.x));
  for (const e of els) {
    e.mirror = !e.mirror;
    if (els.length > 1) e.x = Math.round(minX + maxX - e.x);
  }
  refreshAttached(doc, page, new Set(els.map((e) => e.id)));
}

/**
 * Pivot for rotating a group. The centre of the hotspots' bbox is invariant under the rotation, so
 * rotating 4× is an exact identity — used whenever rotating about it keeps grid points on the grid.
 * Otherwise (no such exact pivot exists) fall back to the grid-snapped centroid.
 */
function rotationPivot(doc: Doc, els: { x: number; y: number }[]): Pt {
  const xs = els.map((e) => e.x), ys = els.map((e) => e.y);
  const b = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const g = doc.grid?.size || 10;
  const onGrid = (v: number) => Math.abs(v / g - Math.round(v / g)) < 1e-9;
  // grid point (O+kg, O+mg) rotated about b stays on the grid iff b.x+b.y-2O ≡ 0 and b.y-b.x ≡ 0 (mod g)
  return onGrid(b.x + b.y - 2 * GRID_ORIGIN) && onGrid(b.y - b.x) ? b : centroid(els);
}

function centroid(els: { x: number; y: number }[]): Pt {
  if (!els.length) return { x: 0, y: 0 };
  const x = els.reduce((a, e) => a + e.x, 0) / els.length;
  const y = els.reduce((a, e) => a + e.y, 0) / els.length;
  return { x: Math.round(x / 10) * 10 + 5, y: Math.round(y / 10) * 10 + 5 };
}

/* ------------------------------------------------------------------ */
/* Deletion & junction housekeeping                                     */
/* ------------------------------------------------------------------ */

export function deleteSelection(doc: Doc, page: Page, sel: Sel) {
  const els = new Set(sel.elements.filter((id) => !page.elements.find((e) => e.id === id)?.locked));
  const js = new Set(sel.junctions);
  const ws = new Set(sel.wires);
  // Deleting a component (or junction) keeps its wires exactly where they are: the ends that were
  // attached to it become free (dangling) and re-attach when a component is dropped onto them.
  // Deleting a wire removes only that wire.
  for (const w of page.wires) {
    if (ws.has(w.id)) continue;
    for (const k of ["a", "b"] as const) {
      const end = w[k];
      if ((end.k === "pin" && els.has(end.el)) || (end.k === "junction" && js.has(end.j))) w[k] = { k: "free" };
    }
  }
  page.elements = page.elements.filter((e) => !els.has(e.id));
  page.wires = page.wires.filter((w) => !ws.has(w.id));
  page.junctions = page.junctions.filter((j) => !js.has(j.id));
  page.texts = page.texts.filter((t) => !sel.texts.includes(t.id));
  cleanupJunctions(page);
}

/**
 * Junction with 2 wires → merge wires; 1 wire → remove junction (free end); 0 → remove.
 * Linear per pass: attachments are indexed once, and a junction whose wires were already rewritten in
 * the current pass is deferred to the next one (merges never change the degree of other junctions).
 */
export function cleanupJunctions(page: Page) {
  for (;;) {
    const att = new Map<string, { w: Wire; end: "a" | "b" }[]>();
    for (const w of page.wires)
      for (const end of ["a", "b"] as const) {
        const e = w[end];
        if (e.k !== "junction") continue;
        const l = att.get(e.j);
        if (l) l.push({ w, end });
        else att.set(e.j, [{ w, end }]);
      }
    const touched = new Set<string>();
    const replaced = new Map<string, Wire>();
    const removedWires = new Set<string>();
    const removedJunctions = new Set<string>();
    let deferred = false;
    for (const j of page.junctions) {
      const a = att.get(j.id) ?? [];
      if (a.length >= 3) continue;
      if (a.some((x) => touched.has(x.w.id))) {
        deferred = true;
        continue;
      }
      if (a.length === 2 && a[0].w.id !== a[1].w.id) {
        const [x, y] = a;
        const other = (q: { w: Wire; end: "a" | "b" }) => (q.end === "a" ? q.w.b : q.w.a);
        // orient pts from merged.a to merged.b
        const xs = x.end === "a" ? [...x.w.pts].reverse() : [...x.w.pts];
        const ys = y.end === "b" ? [...y.w.pts].reverse() : [...y.w.pts];
        const merged: Wire = { ...x.w, id: x.w.id, a: other(x), b: other(y), pts: simplify([...xs, ...ys.slice(1)]), label: x.w.label || y.w.label };
        replaced.set(x.w.id, merged);
        removedWires.add(y.w.id);
        touched.add(x.w.id).add(y.w.id);
        removedJunctions.add(j.id);
      } else if (a.length <= 1) {
        for (const q of a) {
          q.w[q.end] = { k: "free" };
          touched.add(q.w.id);
        }
        removedJunctions.add(j.id);
      }
    }
    if (!removedJunctions.size) return;
    if (removedWires.size || replaced.size) page.wires = page.wires.filter((w) => !removedWires.has(w.id)).map((w) => replaced.get(w.id) ?? w);
    page.junctions = page.junctions.filter((q) => !removedJunctions.has(q.id));
    if (!deferred) return;
  }
}

/* ------------------------------------------------------------------ */
/* Wires                                                                */
/* ------------------------------------------------------------------ */

export type EndTarget =
  | { k: "pin"; el: string; pin: string; p: Pt }
  | { k: "junction"; j: string; p: Pt }
  | { k: "wire"; wire: string; seg: number; p: Pt } // T-connection on an existing wire → creates a junction
  | { k: "wireEnd"; wire: string; end: "a" | "b"; p: Pt } // joining another wire's free end
  | { k: "free"; p: Pt };

/** Split a wire at a point and return the new junction id. */
export function splitWireWithJunction(page: Page, wireId: string, seg: number, p: Pt): string {
  const w = page.wires.find((x) => x.id === wireId);
  if (!w) throw new Error("wire not found");
  const j: Junction = { id: uid(), x: p.x, y: p.y };
  const [p1, p2] = splitAt(w.pts, seg, p);
  const w2: Wire = { ...w, id: uid(), a: { k: "junction", j: j.id }, b: w.b, pts: p2, qet: undefined, label: w.label };
  w.b = { k: "junction", j: j.id };
  w.pts = p1;
  page.junctions.push(j);
  page.wires.push(w2);
  return j.id;
}

/** Resolve a target into a concrete WireEnd, creating junctions when needed. */
export function resolveEnd(page: Page, t: EndTarget): WireEnd {
  switch (t.k) {
    case "pin":
      return { k: "pin", el: t.el, pin: t.pin };
    case "junction":
      return { k: "junction", j: t.j };
    case "wire": {
      // the target wire may have been split since the target was computed: re-locate by point
      let best: { w: Wire; i: number; d: number } | null = null;
      for (const w of page.wires) {
        const n = nearestSegment(w.pts, t.p);
        if (!n || n.d > 0.5) continue;
        const d = n.d - (w.id === t.wire ? 0.01 : 0);
        if (!best || d < best.d) best = { w, i: n.i, d };
      }
      if (!best) return { k: "free" };
      const a = best.w.pts[0], z = best.w.pts[best.w.pts.length - 1];
      if (eqPt(a, t.p) && best.w.a.k !== "free") return best.w.a;
      if (eqPt(z, t.p) && best.w.b.k !== "free") return best.w.b;
      return { k: "junction", j: splitWireWithJunction(page, best.w.id, best.i, t.p) };
    }
    case "wireEnd": {
      const w = page.wires.find((x) => x.id === t.wire);
      if (!w) return { k: "free" };
      const cur = w[t.end];
      if (cur.k === "pin" || cur.k === "junction") return cur;
      // two free ends meet: create a junction (degree 2 → merged by cleanup)
      const j: Junction = { id: uid(), x: t.p.x, y: t.p.y };
      page.junctions.push(j);
      w[t.end] = { k: "junction", j: j.id };
      return { k: "junction", j: j.id };
    }
    default:
      return { k: "free" };
  }
}

export function addWire(page: Page, from: EndTarget, to: EndTarget, pts: Pt[], extra: Partial<Wire> = {}): Wire | null {
  const path = simplify(pts);
  if (path.length < 2 || (path.length === 2 && eqPt(path[0], path[1]))) return null;
  const a = resolveEnd(page, from);
  const b = resolveEnd(page, to);
  if (a.k !== "free" && b.k !== "free" && JSON.stringify(a) === JSON.stringify(b)) return null;
  const w: Wire = { id: uid(), a, b, pts: path, ...extra };
  page.wires.push(w);
  cleanupJunctions(page);
  return w;
}

/** Re-attach one end of an existing wire (drag endpoint). */
export function reattachEnd(doc: Doc, page: Page, wireId: string, end: "a" | "b", t: EndTarget) {
  const w = page.wires.find((x) => x.id === wireId);
  if (!w) return;
  const newEnd = resolveEnd(page, t);
  const w2 = page.wires.find((x) => x.id === wireId)!;
  w2[end] = newEnd;
  w2.pts = moveEndpoint(w2.pts, end, t.p);
  cleanupJunctions(page);
}

/* ------------------------------------------------------------------ */
/* Auto-connect after a move (visible, undoable)                        */
/* ------------------------------------------------------------------ */

export type AutoConnect = { el: string; pin: string; wire: string; end: "a" | "b"; p: Pt };

/** Free wire ends that coincide with unconnected pins of the given elements. */
export function findAutoConnections(doc: Doc, page: Page, elIds: string[]): AutoConnect[] {
  const out: AutoConnect[] = [];
  const connected = new Set<string>();
  for (const w of page.wires) for (const e of [w.a, w.b]) if (e.k === "pin") connected.add(e.el + "/" + e.pin);
  for (const id of elIds) {
    const el = page.elements.find((e) => e.id === id);
    const def = el && doc.defs[el.defId];
    if (!el || !def) continue;
    for (const pin of def.pins) {
      if (connected.has(el.id + "/" + pin.id)) continue;
      const p = toScene(el, pin);
      for (const w of page.wires) {
        if (w.a.k === "free" && eqPt(w.pts[0], p, 0.5)) out.push({ el: el.id, pin: pin.id, wire: w.id, end: "a", p });
        else if (w.b.k === "free" && eqPt(w.pts[w.pts.length - 1], p, 0.5)) out.push({ el: el.id, pin: pin.id, wire: w.id, end: "b", p });
      }
    }
  }
  return out;
}

export function applyAutoConnections(page: Page, list: AutoConnect[]) {
  for (const c of list) {
    const w = page.wires.find((x) => x.id === c.wire);
    if (w) w[c.end] = { k: "pin", el: c.el, pin: c.pin };
  }
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                            */
/* ------------------------------------------------------------------ */

export type Clip = { defs: Record<string, ElementDef>; elements: ElemInst[]; wires: Wire[]; junctions: Junction[]; texts: FreeText[] };

export function copySelection(doc: Doc, page: Page, sel: Sel): Clip {
  const els = page.elements.filter((e) => sel.elements.includes(e.id));
  const js = page.junctions.filter((j) => sel.junctions.includes(j.id));
  const ids = new Set([...els.map((e) => e.id), ...js.map((j) => j.id)]);
  const inside = (we: WireEnd) => we.k === "free" || (we.k === "pin" && ids.has(we.el)) || (we.k === "junction" && ids.has(we.j));
  const wires = page.wires.filter((w) => sel.wires.includes(w.id) || (inside(w.a) && inside(w.b) && (w.a.k !== "free" || w.b.k !== "free")));
  const defs: Record<string, ElementDef> = {};
  for (const e of els) defs[e.defId] = doc.defs[e.defId];
  return JSON.parse(JSON.stringify({ defs, elements: els, wires, junctions: js, texts: page.texts.filter((t) => sel.texts.includes(t.id)) }));
}

/** Paste with fresh ids; wires attached to things outside the clip become free. Returns new selection. */
export function pasteClip(doc: Doc, page: Page, clip: Clip, offset: Pt, renumber = true): Sel {
  const map = new Map<string, string>();
  for (const [id, d] of Object.entries(clip.defs)) if (!doc.defs[id]) doc.defs[id] = d;
  const sel = emptySel();
  const relabel = new Map<string, string>();
  // masters first so slaves pick up the master's new reference regardless of clip order
  const rank = (e: ElemInst) => ((clip.defs[e.defId] ?? doc.defs[e.defId])?.linkType === "slave" ? 1 : 0);
  const ordered = [...clip.elements].sort((a, b) => rank(a) - rank(b));
  for (const e of ordered) {
    const n: ElemInst = { ...JSON.parse(JSON.stringify(e)), id: uid(), x: e.x + offset.x, y: e.y + offset.y, qet: undefined, group: e.group, links: undefined };
    n.texts = n.texts.map((t) => ({ ...t, id: uid(), uuid: undefined }));
    map.set(e.id, n.id);
    const old = e.info.label ?? "";
    const lt = clip.defs[e.defId]?.linkType ?? doc.defs[e.defId]?.linkType ?? "simple";
    if (renumber && doc.numbering.autoOnPlace && !n.refLocked && old && !relabel.has(old) && lt !== "slave" && lt !== "next_report" && lt !== "previous_report") {
      n.info.label = "";
      page.elements.push(n);
      const ref = nextRef(doc, page, n);
      n.info.label = ref || old;
      relabel.set(old, n.info.label);
    } else {
      // elements sharing a reference (coil ↔ its contacts) keep sharing the renumbered one
      if (old && relabel.has(old)) n.info.label = relabel.get(old)!;
      page.elements.push(n);
    }
  }
  sel.elements = clip.elements.map((e) => map.get(e.id)!); // clip order (placeBlock maps by index)
  for (const j of clip.junctions) {
    const n = { ...j, id: uid(), x: j.x + offset.x, y: j.y + offset.y, qetElemId: undefined };
    map.set(j.id, n.id);
    page.junctions.push(n);
    sel.junctions.push(n.id);
  }
  const remap = (we: WireEnd): WireEnd => {
    if (we.k === "pin") return map.has(we.el) ? { k: "pin", el: map.get(we.el)!, pin: we.pin } : { k: "free" };
    if (we.k === "junction") return map.has(we.j) ? { k: "junction", j: map.get(we.j)! } : { k: "free" };
    return we;
  };
  for (const w of clip.wires) {
    const n: Wire = { ...JSON.parse(JSON.stringify(w)), id: uid(), a: remap(w.a), b: remap(w.b), pts: translatePts(w.pts, offset), qet: undefined };
    page.wires.push(n);
    sel.wires.push(n.id);
  }
  for (const t of clip.texts) {
    const n = { ...t, id: uid(), x: t.x + offset.x, y: t.y + offset.y, qet: undefined };
    page.texts.push(n);
    sel.texts.push(n.id);
  }
  cleanupJunctions(page);
  return sel;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                 */
/* ------------------------------------------------------------------ */

export function pinOrientScene(e: ElemInst, def: ElementDef, pinId: string) {
  const pin = def.pins.find((p) => p.id === pinId);
  return pin ? rotOrient(pin.orient, e.rot, e.mirror) : null;
}

/** Nearest segment hit on any wire of the page. */
export function hitWire(page: Page, p: Pt, tol: number): { w: Wire; seg: number; p: Pt; d: number } | null {
  let best: { w: Wire; seg: number; p: Pt; d: number } | null = null;
  for (const w of page.wires) {
    const n = nearestSegment(w.pts, p);
    if (n && n.d <= tol && (!best || n.d < best.d)) best = { w, seg: n.i, p: n.p, d: n.d };
  }
  return best;
}

export { wiresOfElement };
