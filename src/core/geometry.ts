import type { ElemInst, ElementDef, Orient, Pt, Rect } from "./model";

export const ORIENTS: Orient[] = ["n", "e", "s", "w"];

/** Transform a point from element-local (hotspot origin) to scene. */
export function toScene(e: Pick<ElemInst, "x" | "y" | "rot" | "mirror">, p: Pt): Pt {
  let x = e.mirror ? -p.x : p.x;
  let y = p.y;
  for (let i = 0; i < e.rot; i++) {
    const t = x;
    x = -y;
    y = t;
  }
  return { x: e.x + x, y: e.y + y };
}

/** Inverse of toScene. */
export function toLocal(e: Pick<ElemInst, "x" | "y" | "rot" | "mirror">, p: Pt): Pt {
  let x = p.x - e.x;
  let y = p.y - e.y;
  for (let i = 0; i < e.rot; i++) {
    const t = x;
    x = y;
    y = -t;
  }
  if (e.mirror) x = -x;
  return { x, y };
}

export function rotOrient(o: Orient, rot: number, mirror: boolean): Orient {
  let i = ORIENTS.indexOf(o);
  if (mirror && (o === "e" || o === "w")) i = (i + 2) % 4;
  return ORIENTS[(i + rot) % 4];
}

export const orientVec = (o: Orient): Pt => (o === "n" ? { x: 0, y: -1 } : o === "s" ? { x: 0, y: 1 } : o === "e" ? { x: 1, y: 0 } : { x: -1, y: 0 });

/** 2D affine matrix [a b c d e f] like canvas setTransform */
export type Mat = [number, number, number, number, number, number];
export function elemMatrix(e: Pick<ElemInst, "x" | "y" | "rot" | "mirror">): Mat {
  const cos = [1, 0, -1, 0][e.rot];
  const sin = [0, 1, 0, -1][e.rot];
  const sx = e.mirror ? -1 : 1;
  // M = T * R * S
  return [cos * sx, sin * sx, -sin, cos, e.x, e.y];
}
export const applyMat = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export function mulMat(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function defLocalRect(d: ElementDef): Rect {
  return { x: -d.hotspotX, y: -d.hotspotY, w: d.width, h: d.height };
}

export function transformRect(e: Pick<ElemInst, "x" | "y" | "rot" | "mirror">, r: Rect): Rect {
  const a = toScene(e, { x: r.x, y: r.y });
  const b = toScene(e, { x: r.x + r.w, y: r.y + r.h });
  return normRect(a, b);
}

export function normRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
export const rectContains = (r: Rect, p: Pt) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export const rectsIntersect = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const rectInside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
export const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
export function ptsBBox(pts: Pt[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const eqPt = (a: Pt, b: Pt, eps = 0.01) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
export const snapTo = (v: number, g: number) => Math.round(v / g) * g;

/** Closest point on segment ab to p; returns point and param t. */
export function closestOnSeg(p: Pt, a: Pt, b: Pt): { p: Pt; t: number; d: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { p: q, t, d: dist(p, q) };
}

export function segBBox(a: Pt, b: Pt): Rect {
  return normRect(a, b);
}

/** Proper crossing / touching test for axis-aligned or arbitrary segments. */
export function pointOnSeg(p: Pt, a: Pt, b: Pt, eps = 0.5): boolean {
  return closestOnSeg(p, a, b).d <= eps;
}

export function polylineLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}
export function pointAlong(pts: Pt[], t: number): { p: Pt; horizontal: boolean } {
  const total = polylineLength(pts);
  let target = total * t;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (target <= l || i === pts.length - 1) {
      const f = l === 0 ? 0 : Math.min(1, target / l);
      const a = pts[i - 1], b = pts[i];
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, horizontal: Math.abs(b.y - a.y) < Math.abs(b.x - a.x) };
    }
    target -= l;
  }
  return { p: pts[0], horizontal: true };
}

/** Grid origin: QElectroTech puts its grid on absolute scene multiples of 10 while Volt pages
 *  start at QET's border (scene 5,5) — so Volt grid points sit at 10k + 5. */
export const GRID_ORIGIN = 5;
export const snapGrid = (v: number, g: number) => Math.round((v - GRID_ORIGIN) / g) * g + GRID_ORIGIN;
export const snapPt = (p: Pt, g: number): Pt => ({ x: snapGrid(p.x, g), y: snapGrid(p.y, g) });
