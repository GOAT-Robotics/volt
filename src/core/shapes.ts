/**
 * Free drawing shapes: geometry helpers (hit testing, outline segments) and conversion of drawn
 * lines into real, connected wires.
 */
import type { Doc, Page, Pt, Shape, Wire, WireEnd } from "./model";
import { dist, toScene } from "./geometry";
import { uid } from "./ids";
import { cleanupJunctions, resolveEnd } from "./ops";
import { nearestSegment, simplify } from "./wires";

/** Is the shape an open path (line / open polyline) — i.e. something that can become a wire? */
export const isOpenPath = (s: Shape) => s.kind === "line" || (s.kind === "polygon" && s.closed === false);

/** Outline of a shape as polyline(s) in scene coordinates (ellipses approximated). */
export function shapeOutline(s: Shape): Pt[] {
  if (s.kind === "rect" && s.pts.length >= 2) {
    const [a, c] = s.pts;
    return [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }, a];
  }
  if (s.kind === "ellipse" && s.pts.length >= 2) {
    const [a, c] = s.pts;
    const cx = (a.x + c.x) / 2, cy = (a.y + c.y) / 2, rx = Math.abs(c.x - a.x) / 2, ry = Math.abs(c.y - a.y) / 2;
    const out: Pt[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
    }
    return out;
  }
  if (s.kind === "polygon" && s.closed !== false && s.pts.length > 2) return [...s.pts, s.pts[0]];
  return s.pts;
}

export function shapeBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Distance from p to the shape (0 inside a filled shape). */
export function shapeDistance(s: Shape, p: Pt): number {
  if (s.fill && s.kind !== "line") {
    const b = shapeBounds(s);
    if (s.kind === "ellipse") {
      const rx = b.w / 2 || 1, ry = b.h / 2 || 1;
      const dx = (p.x - (b.x + rx)) / rx, dy = (p.y - (b.y + ry)) / ry;
      if (dx * dx + dy * dy <= 1) return 0;
    } else if (s.kind === "rect") {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return 0;
    } else if (pointInPolygon(p, s.pts)) return 0;
  }
  const n = nearestSegment(shapeOutline(s), p);
  return n ? n.d : Infinity;
}

function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* ------------------------------------------------------------------ */
/* Lines → wires                                                        */
/* ------------------------------------------------------------------ */

export type ConvertResult = { wires: string[]; converted: number; skipped: number; pinEnds: number };

type End = { s: number; end: "a" | "b"; p: Pt };
type Node = { ends: End[]; p: Pt; to: WireEnd | null; pinned: boolean };

/**
 * Turn drawn lines / open polylines into wires.
 *
 * - Line ends that meet (within `tol`) become one connection point: corners merge into a single
 *   wire, three or more ends make a junction.
 * - An end near a component pin (within `pinTol`) snaps onto the pin and connects to it.
 * - An end touching another line / wire in the middle makes a T junction.
 * - Nearly horizontal / vertical segments are straightened.
 * Closed shapes (rectangles, ellipses, closed polygons) are left alone. The converted shapes are removed.
 */
export function convertShapesToWires(doc: Doc, page: Page, shapeIds: string[], opts: { tol?: number; pinTol?: number } = {}): ConvertResult {
  const tol = opts.tol ?? 2;
  const pinTol = opts.pinTol ?? 6;
  const want = new Set(shapeIds);
  const shapes = page.shapes.filter((s) => want.has(s.id) && isOpenPath(s) && s.pts.length >= 2);
  const skipped = shapeIds.length - shapes.length;
  if (!shapes.length) return { wires: [], converted: 0, skipped, pinEnds: 0 };

  // polylines, with duplicate points removed
  const paths = shapes.map((s) => s.pts.filter((p, i) => i === 0 || dist(p, s.pts[i - 1]) > 1e-6).map((p) => ({ ...p })));

  // 1. cluster line ends
  const ends: End[] = [];
  paths.forEach((pts, i) => {
    if (pts.length < 2) return;
    ends.push({ s: i, end: "a", p: pts[0] }, { s: i, end: "b", p: pts[pts.length - 1] });
  });
  const parent = ends.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) if (dist(ends[i].p, ends[j].p) <= tol) parent[find(i)] = find(j);
  const groups = new Map<number, End[]>();
  ends.forEach((e, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(e);
    else groups.set(r, [e]);
  });

  // 2. anchor each cluster: pin > existing junction > existing free wire end > centroid
  const pins: { p: Pt; el: string; pin: string }[] = [];
  for (const e of page.elements) {
    const def = doc.defs[e.defId];
    if (def) for (const pin of def.pins) pins.push({ p: toScene(e, pin), el: e.id, pin: pin.id });
  }
  const nodes: Node[] = [];
  const nodeOf = new Map<string, Node>();
  let pinEnds = 0;
  for (const g of groups.values()) {
    const c = { x: g.reduce((a, e) => a + e.p.x, 0) / g.length, y: g.reduce((a, e) => a + e.p.y, 0) / g.length };
    let node: Node = { ends: g, p: c, to: null, pinned: false };
    let best: { p: Pt; to: WireEnd; d: number } | null = null;
    for (const q of pins) {
      const d = Math.min(...g.map((e) => dist(e.p, q.p)));
      if (d <= pinTol && (!best || d < best.d)) best = { p: q.p, to: { k: "pin", el: q.el, pin: q.pin }, d };
    }
    if (!best)
      for (const j of page.junctions) {
        const d = dist(c, j);
        if (d <= tol && (!best || d < best.d)) best = { p: { x: j.x, y: j.y }, to: { k: "junction", j: j.id }, d };
      }
    if (best) {
      node = { ends: g, p: { ...best.p }, to: best.to, pinned: true };
      if (best.to.k === "pin") pinEnds += g.length;
    }
    nodes.push(node);
    for (const e of g) nodeOf.set(`${e.s}${e.end}`, node);
  }

  // 3. straighten nearly horizontal / vertical runs. A pinned node's coordinates are fixed; others
  //    adopt the coordinate of a fixed neighbour, or share the average when neither is fixed.
  const STRAIGHT = Math.max(tol, 2);
  const lock = new Map<Node, { x: boolean; y: boolean }>(nodes.map((n) => [n, { x: n.pinned, y: n.pinned }]));
  for (let pass = 0; pass < 6; pass++)
    paths.forEach((pts, i) => {
      if (pts.length !== 2) return;
      const a = nodeOf.get(`${i}a`)!, b = nodeOf.get(`${i}b`)!;
      if (a === b) return;
      const la = lock.get(a)!, lb = lock.get(b)!;
      const horiz = Math.abs(a.p.y - b.p.y) <= STRAIGHT && Math.abs(a.p.x - b.p.x) > STRAIGHT;
      const vert = Math.abs(a.p.x - b.p.x) <= STRAIGHT && Math.abs(a.p.y - b.p.y) > STRAIGHT;
      const k = horiz ? "y" : vert ? "x" : null;
      if (!k || a.p[k] === b.p[k]) return;
      if (la[k] && !lb[k]) (b.p = { ...b.p, [k]: a.p[k] }), (lb[k] = true);
      else if (lb[k] && !la[k]) (a.p = { ...a.p, [k]: b.p[k] }), (la[k] = true);
      else if (!la[k] && !lb[k] && pass >= 3) {
        const v = (a.p[k] + b.p[k]) / 2;
        a.p = { ...a.p, [k]: v };
        b.p = { ...b.p, [k]: v };
        la[k] = lb[k] = true;
      }
    });
  // snap every path end onto its node and straighten nearly-orthogonal inner segments
  paths.forEach((pts, i) => {
    pts[0] = { ...nodeOf.get(`${i}a`)!.p };
    pts[pts.length - 1] = { ...nodeOf.get(`${i}b`)!.p };
    for (let k = 1; pts.length > 2 && k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      if (Math.abs(a.y - b.y) <= 1 && Math.abs(a.x - b.x) > 1) (k === pts.length - 1 ? (a.y = b.y) : (b.y = a.y));
      else if (Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) > 1) (k === pts.length - 1 ? (a.x = b.x) : (b.x = a.x));
    }
  });

  // 4. junctions for clusters of 2+ ends without an anchor (2 = corner, merged away by cleanup)
  for (const n of nodes) {
    if (n.to || n.ends.length < 2) continue;
    const j = { id: uid(), x: n.p.x, y: n.p.y };
    page.junctions.push(j);
    n.to = { k: "junction", j: j.id };
  }

  // 5. create the wires
  const created: Wire[] = [];
  paths.forEach((pts, i) => {
    const path = simplify(pts);
    if (path.length < 2) return;
    const s = shapes[i];
    const a = nodeOf.get(`${i}a`)!, b = nodeOf.get(`${i}b`)!;
    const w: Wire = { id: uid(), a: a.to ?? { k: "free" }, b: b.to ?? { k: "free" }, pts: path };
    const black = /^#0{6}$|^black$/i.test(s.color);
    if (!black || s.dash !== "solid") w.override = { ...(black ? {} : { color: s.color }), ...(s.dash !== "solid" ? { dash: s.dash } : {}) };
    page.wires.push(w);
    created.push(w);
  });

  // 6. single free ends touching another wire in the middle → T junction
  for (const w of created) {
    for (const end of ["a", "b"] as const) {
      if (w[end].k !== "free") continue;
      const p = end === "a" ? w.pts[0] : w.pts[w.pts.length - 1];
      let hit: { w: Wire; p: Pt; d: number; i: number } | null = null;
      for (const o of page.wires) {
        if (o.id === w.id) continue;
        const n = nearestSegment(o.pts, p);
        if (!n || n.d > tol) continue;
        // skip the other wire's own end points (those were handled by clustering)
        if (dist(n.p, o.pts[0]) < 1e-6 || dist(n.p, o.pts[o.pts.length - 1]) < 1e-6) continue;
        if (!hit || n.d < hit.d) hit = { w: o, p: n.p, d: n.d, i: n.i };
      }
      if (!hit) continue;
      const q = { x: Math.round(hit.p.x * 1000) / 1000, y: Math.round(hit.p.y * 1000) / 1000 };
      if (end === "a") w.pts[0] = q;
      else w.pts[w.pts.length - 1] = q;
      w[end] = resolveEnd(page, { k: "wire", wire: hit.w.id, seg: hit.i, p: q });
    }
  }

  page.shapes = page.shapes.filter((s) => !shapes.includes(s));
  cleanupJunctions(page);
  const alive = new Set(page.wires.map((w) => w.id));
  return { wires: created.map((w) => w.id).filter((id) => alive.has(id)), converted: shapes.length, skipped, pinEnds };
}
