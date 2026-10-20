/**
 * Geometry of drawn shapes (no rendering, no editing): outlines, boxes, block-diagram forms, where
 * text goes inside a shape, arrow heads, hit distance.
 */
import type { Pt, Shape, ShapeForm } from "./model";
import { closestOnSeg, dist } from "./geometry";

/** Is the shape an open path (line / open polyline) — i.e. something that can become a wire? */
export const isOpenPath = (s: Shape) => s.kind === "line" || (s.kind === "polygon" && s.closed === false);

type Box = { x: number; y: number; w: number; h: number };

/** the box of a rectangle / ellipse (its two corners in any order) */
export function shapeBox(s: Shape): Box {
  const [a, c] = s.pts;
  if (!c) return { x: a?.x ?? 0, y: a?.y ?? 0, w: 0, h: 0 };
  return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
}

/** a corner radius that fits the box */
export const cornerRadius = (s: Shape, b: Box) => Math.max(0, Math.min(s.radius ?? 0, b.w / 2, b.h / 2));

/** maps a point of a form drawn upright in a local lw × lh box onto the shape's box (flip, then quarter turns clockwise) */
function placer(s: Shape, b: Box) {
  const t = s.turn ?? 0;
  const lw = t % 2 ? b.h : b.w, lh = t % 2 ? b.w : b.h;
  const at = (u0: number, v: number): Pt => {
    const u = s.flip ? lw - u0 : u0;
    if (t === 1) return { x: b.x + (lh - v), y: b.y + u };
    if (t === 2) return { x: b.x + lw - u, y: b.y + lh - v };
    if (t === 3) return { x: b.x + v, y: b.y + lw - u };
    return { x: b.x + u, y: b.y + v };
  };
  return { lw, lh, at };
}

const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });

/** a form's outline (closed, first point not repeated), extra lines drawn on it (a cylinder's rim) and the box its text goes in, all in local coordinates */
function formLocal(form: ShapeForm, lw: number, lh: number): { outline: Pt[]; rims: Pt[][]; text: Box } {
  switch (form) {
    case "diamond":
      return { outline: [{ x: lw / 2, y: 0 }, { x: lw, y: lh / 2 }, { x: lw / 2, y: lh }, { x: 0, y: lh / 2 }], rims: [], text: { x: lw / 4, y: lh / 4, w: lw / 2, h: lh / 2 } };
    case "hexagon": {
      const k = Math.min(lw * 0.25, lh * 0.5);
      return { outline: [{ x: k, y: 0 }, { x: lw - k, y: 0 }, { x: lw, y: lh / 2 }, { x: lw - k, y: lh }, { x: k, y: lh }, { x: 0, y: lh / 2 }], rims: [], text: { x: k * 0.6, y: 0, w: lw - k * 1.2, h: lh } };
    }
    case "triangle":
      return { outline: [{ x: lw / 2, y: 0 }, { x: lw, y: lh }, { x: 0, y: lh }], rims: [], text: { x: lw / 4, y: lh / 2, w: lw / 2, h: lh / 2 } };
    case "parallelogram": {
      const k = Math.min(lw * 0.25, lh * 0.5);
      return { outline: [{ x: k, y: 0 }, { x: lw, y: 0 }, { x: lw - k, y: lh }, { x: 0, y: lh }], rims: [], text: { x: k, y: 0, w: lw - 2 * k, h: lh } };
    }
    case "cylinder": {
      const rx = lw / 2, ry = Math.min(lh * 0.15, lw * 0.25);
      const top = arc(rx, ry, rx, ry, Math.PI, Math.PI * 2);
      const bottom = arc(rx, lh - ry, rx, ry, 0, Math.PI);
      return { outline: [...top, ...bottom], rims: [arc(rx, ry, rx, ry, 0, Math.PI)], text: { x: 0, y: ry * 2, w: lw, h: Math.max(0, lh - ry * 3) } };
    }
    case "document": {
      const base = lh * 0.86, amp = lh * 0.07;
      const wave = Array.from({ length: 33 }, (_, i) => {
        const t = i / 32;
        return { x: lw * (1 - t), y: base + amp * Math.sin(Math.PI * 2 * t) };
      });
      return { outline: [{ x: 0, y: 0 }, { x: lw, y: 0 }, ...wave], rims: [], text: { x: 0, y: 0, w: lw, h: base - amp } };
    }
  }
}

/** A rectangle's block-diagram form in scene coordinates: closed outline, extra lines and the text box. */
export function formGeometry(s: Shape): { outline: Pt[]; rims: Pt[][]; text: Box } | null {
  if (s.kind !== "rect" || !s.form || s.pts.length < 2) return null;
  const b = shapeBox(s);
  const { lw, lh, at } = placer(s, b);
  const f = formLocal(s.form, lw, lh);
  const t = [at(f.text.x, f.text.y), at(f.text.x + f.text.w, f.text.y + f.text.h)];
  return {
    outline: f.outline.map((p) => at(p.x, p.y)),
    rims: f.rims.map((r) => r.map((p) => at(p.x, p.y))),
    text: { x: Math.min(t[0].x, t[1].x), y: Math.min(t[0].y, t[1].y), w: Math.abs(t[1].x - t[0].x), h: Math.abs(t[1].y - t[0].y) },
  };
}

/** Where a shape's text goes: the part of a closed shape text fits in (null for lines and open polylines). */
export function shapeTextBox(s: Shape): Box | null {
  if (isOpenPath(s)) return null;
  const f = formGeometry(s);
  if (f) return f.text;
  if (s.kind === "ellipse") {
    const b = shapeBox(s);
    const k = (1 - Math.SQRT1_2) / 2;
    return { x: b.x + b.w * k, y: b.y + b.h * k, w: b.w * Math.SQRT1_2, h: b.h * Math.SQRT1_2 };
  }
  if (s.kind === "rect") return shapeBox(s);
  return shapeBounds(s);
}

/** the point halfway along a line / polyline (where its label sits) and the direction there */
export function pathMiddle(pts: Pt[]): { p: Pt; dx: number; dy: number } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (d >= left && d > 0) {
      const k = left / d;
      return { p: { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k }, dx: (pts[i].x - pts[i - 1].x) / d, dy: (pts[i].y - pts[i - 1].y) / d };
    }
    left -= d;
  }
  return { p: pts[0] ?? { x: 0, y: 0 }, dx: 1, dy: 0 };
}

/** arrow head size for a line width: length and half width, scene units */
export const arrowSize = (width: number) => {
  const len = 6 + Math.max(0, width) * 3;
  return { len, half: len * 0.38 };
};

/** The arrow heads of a line / open polyline (triangles, tip first) and its path shortened so the line ends inside them. */
export function arrowGeometry(s: Shape): { heads: Pt[][]; path: Pt[] } {
  const path = s.pts.map((p) => ({ ...p }));
  const heads: Pt[][] = [];
  if (!isOpenPath(s) || path.length < 2 || !s.arrows) return { heads, path };
  const { len, half } = arrowSize(s.width);
  const head = (tip: Pt, from: Pt, move: (p: Pt) => void) => {
    const d = dist(tip, from);
    if (d < 1e-6) return;
    const ux = (tip.x - from.x) / d, uy = (tip.y - from.y) / d;
    const bx = tip.x - ux * len, by = tip.y - uy * len;
    heads.push([{ ...tip }, { x: bx - uy * half, y: by + ux * half }, { x: bx + uy * half, y: by - ux * half }]);
    // the line stops inside the head, so a thick line does not show past its point
    if (d > len) move({ x: tip.x - ux * len * 0.7, y: tip.y - uy * len * 0.7 });
  };
  if (s.arrows.end) head(path[path.length - 1], path[path.length - 2], (p) => (path[path.length - 1] = p));
  if (s.arrows.start) head(s.pts[0], s.pts[1], (p) => (path[0] = p));
  return { heads, path };
}

/** Outline of a shape as polyline(s) in scene coordinates (ellipses approximated). */
export function shapeOutline(s: Shape): Pt[] {
  const f = formGeometry(s);
  if (f) return [...f.outline, f.outline[0]];
  if (s.kind === "rect" && s.pts.length >= 2 && s.radius) {
    const b = shapeBox(s);
    const r = cornerRadius(s, b);
    if (r > 0) {
      const q = Math.PI / 2;
      const out = [
        ...arc(b.x + b.w - r, b.y + r, r, r, -q, 0, 6),
        ...arc(b.x + b.w - r, b.y + b.h - r, r, r, 0, q, 6),
        ...arc(b.x + r, b.y + b.h - r, r, r, q, 2 * q, 6),
        ...arc(b.x + r, b.y + r, r, r, 2 * q, 3 * q, 6),
      ];
      return [...out, out[0]];
    }
  }
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

/** Distance from p to the shape's outline (its inside does not count). */
export function shapeEdgeDistance(s: Shape, p: Pt): number {
  const o = shapeOutline(s);
  if (o.length === 1) return dist(o[0], p);
  let best = Infinity;
  for (let i = 1; i < o.length; i++) best = Math.min(best, closestOnSeg(p, o[i - 1], o[i]).d);
  return best;
}

/** Distance from p to the shape (0 inside a filled shape, or one with text in it). */
export function shapeDistance(s: Shape, p: Pt): number {
  if ((s.fill || s.image || s.label?.text) && !isOpenPath(s)) {
    const b = shapeBounds(s);
    const f = formGeometry(s);
    if (f) {
      if (pointInPolygon(p, f.outline)) return 0;
    } else if (s.kind === "ellipse") {
      const rx = b.w / 2 || 1, ry = b.h / 2 || 1;
      const dx = (p.x - (b.x + rx)) / rx, dy = (p.y - (b.y + ry)) / ry;
      if (dx * dx + dy * dy <= 1) return 0;
    } else if (s.kind === "rect") {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return 0;
    } else if (pointInPolygon(p, s.pts)) return 0;
  }
  const o = shapeOutline(s);
  let best = Infinity;
  for (let i = 1; i < o.length; i++) best = Math.min(best, closestOnSeg(p, o[i - 1], o[i]).d);
  return o.length === 1 ? dist(o[0], p) : best;
}

export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The path of an arrow from one shape to another: from the middle of the side facing the other
 * shape to the middle of its side — straight when the two overlap across that direction, with
 * one bend in the gap between them otherwise.
 */
export function connectorBetween(a: Shape, b: Shape, grid = 10): Pt[] {
  const A = shapeBounds(a), B = shapeBounds(b);
  const ca = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, cb = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
  const snap = (v: number) => Math.round(v / (grid / 2)) * (grid / 2);
  const gapX = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w));
  const gapY = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h));
  // side by side (a horizontal gap at least as wide as the vertical one): left / right sides
  if (gapX >= gapY) {
    const right = cb.x >= ca.x;
    const x1 = right ? A.x + A.w : A.x, x2 = right ? B.x : B.x + B.w;
    const lo = Math.max(A.y, B.y), hi = Math.min(A.y + A.h, B.y + B.h);
    if (hi - lo >= grid) {
      const y = snap((lo + hi) / 2);
      return [{ x: x1, y }, { x: x2, y }];
    }
    const xm = snap((x1 + x2) / 2);
    return [{ x: x1, y: ca.y }, { x: xm, y: ca.y }, { x: xm, y: cb.y }, { x: x2, y: cb.y }];
  }
  const down = cb.y >= ca.y;
  const y1 = down ? A.y + A.h : A.y, y2 = down ? B.y : B.y + B.h;
  const lo = Math.max(A.x, B.x), hi = Math.min(A.x + A.w, B.x + B.w);
  if (hi - lo >= grid) {
    const x = snap((lo + hi) / 2);
    return [{ x, y: y1 }, { x, y: y2 }];
  }
  const ym = snap((y1 + y2) / 2);
  return [{ x: ca.x, y: y1 }, { x: ca.x, y: ym }, { x: cb.x, y: ym }, { x: cb.x, y: y2 }];
}
