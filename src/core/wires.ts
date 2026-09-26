import type { Orient, Pt } from "./model";
import { closestOnSeg, eqPt, GRID_ORIGIN } from "./geometry";
import { normalizePath, qetAutoPath } from "./qet/project";

export const simplify = (pts: Pt[]) => normalizePath(pts);

const isH = (a: Pt, b: Pt) => Math.abs(a.y - b.y) < 0.01;
const isV = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 0.01;

/** QElectroTech-identical automatic route between two oriented terminals (Volt coordinates). */
export function autoRoute(a: Pt, ao: Orient, b: Pt, bo: Orient): Pt[] {
  const sh = (p: Pt, d: number) => ({ x: p.x + d, y: p.y + d });
  return simplify(qetAutoPath(sh(a, GRID_ORIGIN), ao, sh(b, GRID_ORIGIN), bo).map((p) => sh(p, -GRID_ORIGIN)));
}

const DIRV: Record<Orient, Pt> = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } };

/** Route leaving an oriented pin: straight out along the pin direction first, never back through the symbol. */
function routeFromPin(a: Pt, ao: Orient, b: Pt, stub = 10): Pt[] {
  const d = DIRV[ao];
  const vertical = d.x === 0;
  const ahead = vertical ? (b.y - a.y) * d.y : (b.x - a.x) * d.x;
  if (ahead >= stub || (ahead > 0 && (vertical ? a.x === b.x : a.y === b.y))) {
    // target lies in front of the pin: out along the pin axis, then across
    return vertical ? [a, { x: a.x, y: b.y }, b] : [a, { x: b.x, y: a.y }, b];
  }
  // target behind / beside: short stub out, then across, then to the target
  const s = { x: a.x + d.x * stub, y: a.y + d.y * stub };
  return vertical ? [a, s, { x: b.x, y: s.y }, b] : [a, s, { x: s.x, y: b.y }, b];
}

/**
 * Orthogonal route from a to b. Oriented ends (pins) are left/entered along their direction;
 * `hFirst` decides the L-bend when neither end has an orientation.
 */
export function orthoRoute(a: Pt, b: Pt, ao?: Orient | null, bo?: Orient | null, hFirst?: boolean): Pt[] {
  if (eqPt(a, b)) return [a, b];
  if (ao && bo) return autoRoute(a, ao, b, bo);
  if (ao) return simplify(routeFromPin(a, ao, b));
  if (bo) return simplify(routeFromPin(b, bo, a).reverse());
  if (isH(a, b) || isV(a, b)) return [a, b];
  const horizontalFirst = hFirst ?? Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const corner = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  return [a, corner, b];
}

/** Rubber-band: move one endpoint of an orthogonal polyline while keeping it orthogonal. */
export function moveEndpoint(pts: Pt[], which: "a" | "b", to: Pt): Pt[] {
  // normalize first: collinear interior points / duplicates would break the corner logic below
  let p = simplify(which === "a" ? pts : [...pts].reverse());
  if (!p.length) return [{ ...to }];
  if (p.length === 1) p = [p[0], { ...p[0] }]; // zero-length wire: keep its far end fixed
  if (p.length === 2) {
    const [s, e] = p;
    if (isH(to, e) || isV(to, e)) p = [to, e];
    else if (isH(s, e)) {
      const mx = (to.x + e.x) / 2;
      const midX = Math.round(mx / 5) * 5;
      p = [to, { x: midX, y: to.y }, { x: midX, y: e.y }, e];
    } else {
      const my = Math.round((to.y + e.y) / 10) * 5;
      p = [to, { x: to.x, y: my }, { x: e.x, y: my }, e];
    }
  } else {
    const [p0, p1, p2] = p;
    const horizontal = isH(p0, p1);
    p[0] = { ...to };
    if (horizontal ? isH(p1, p2) : isV(p1, p2)) {
      // the path doubles back on itself at p1 (e.g. QET pin stubs): keep p1 and add an elbow before it
      p.splice(1, 0, horizontal ? { x: to.x, y: p1.y } : { x: p1.x, y: to.y });
    } else if (horizontal) p[1] = { x: p1.x, y: to.y };
    else p[1] = { x: to.x, y: p1.y };
  }
  const out = simplify(p);
  if (out.length === 1) out.push({ ...out[0] }); // endpoint dropped onto the other end: keep a 2-point wire
  return which === "a" ? out : out.reverse();
}

/** Drag a segment perpendicular to itself; endpoints stay fixed (stubs are inserted). */
export function moveSegment(pts: Pt[], i: number, d: Pt): Pt[] {
  const p = pts.map((q) => ({ ...q }));
  if (i < 0 || i >= p.length - 1) return p;
  const a = p[i], b = p[i + 1];
  const horizontal = isH(a, b);
  const off = horizontal ? { x: 0, y: d.y } : { x: d.x, y: 0 };
  if (!off.x && !off.y) return p;
  // a neighbour parallel to the dragged segment (path doubling back) cannot follow it: treat it like an end
  const par = (q: Pt, r: Pt) => (horizontal ? isH(q, r) : isV(q, r));
  // keep endpoints: add stubs when moving the first / last segment
  if (i === p.length - 2 || par(p[i + 1], p[i + 2])) p.splice(i + 2, 0, { ...p[i + 1] });
  if (i === 0 || par(p[i - 1], p[i])) {
    p.splice(i, 0, { ...p[i] });
    i++;
  }
  p[i] = { x: p[i].x + off.x, y: p[i].y + off.y };
  p[i + 1] = { x: p[i + 1].x + off.x, y: p[i + 1].y + off.y };
  return simplify(p);
}

export function translatePts(pts: Pt[], d: Pt): Pt[] {
  return pts.map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
}

/** Nearest segment of a polyline to p. */
export function nearestSegment(pts: Pt[], p: Pt): { i: number; p: Pt; d: number; t: number } | null {
  let best: { i: number; p: Pt; d: number; t: number } | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const c = closestOnSeg(p, pts[i], pts[i + 1]);
    if (!best || c.d < best.d) best = { i, p: c.p, d: c.d, t: c.t };
  }
  return best;
}

/** Split a polyline at point p lying on segment i. */
export function splitAt(pts: Pt[], i: number, p: Pt): [Pt[], Pt[]] {
  const first = [...pts.slice(0, i + 1).map((q) => ({ ...q })), { ...p }];
  const second = [{ ...p }, ...pts.slice(i + 1).map((q) => ({ ...q }))];
  return [simplify(first), simplify(second)];
}

/** Join two polylines that share an endpoint (used when a junction degree drops to 2). */
export function joinAt(a: Pt[], b: Pt[], at: Pt): Pt[] {
  const A = eqPt(a[a.length - 1], at) ? a : [...a].reverse();
  const B = eqPt(b[0], at) ? b : [...b].reverse();
  return simplify([...A, ...B.slice(1)]);
}

export function isOrthogonal(pts: Pt[]): boolean {
  for (let i = 1; i < pts.length; i++) if (!isH(pts[i - 1], pts[i]) && !isV(pts[i - 1], pts[i])) return false;
  return true;
}
