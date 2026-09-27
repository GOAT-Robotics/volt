/** Geometry for the symbol editor: hit tests, handles, transforms. Coordinates are element-local (hotspot = 0,0). */
import type { Orient, PinDef, Prim, Pt, Rect } from "@/core/model";
import { pinBounds, primBounds, unionR } from "@/lib/library/elmt-tools";
import type { EdPrim } from "./store";

export const r1 = (v: number) => Math.round(v * 100) / 100;

export function distSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function inPoly(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const filled = (p: Prim) => "style" in p && p.style.filling !== "none";

/** QET angle (deg, CCW from 3 o'clock) of point p on an ellipse box. */
export function qetAngle(p: Pt, box: { x: number; y: number; w: number; h: number }): number {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const rx = Math.abs(box.w / 2) || 1, ry = Math.abs(box.h / 2) || 1;
  return (-Math.atan2((p.y - cy) / ry, (p.x - cx) / rx) * 180) / Math.PI;
}
export function ellipsePoint(box: { x: number; y: number; w: number; h: number }, deg: number): Pt {
  const a = (-deg * Math.PI) / 180;
  return { x: box.x + box.w / 2 + (box.w / 2) * Math.cos(a), y: box.y + box.h / 2 + (box.h / 2) * Math.sin(a) };
}

function angleIn(deg: number, start: number, sweep: number): boolean {
  const n = (v: number) => ((v % 360) + 360) % 360;
  if (Math.abs(sweep) >= 360) return true;
  if (sweep >= 0) return n(deg - start) <= sweep;
  return n(start - deg) <= -sweep;
}

export function hitPrim(p: EdPrim, pt: Pt, tol: number): boolean {
  switch (p.t) {
    case "line":
      return distSeg(pt, { x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }) <= tol;
    case "rect": {
      const x0 = Math.min(p.x, p.x + p.w), y0 = Math.min(p.y, p.y + p.h), x1 = Math.max(p.x, p.x + p.w), y1 = Math.max(p.y, p.y + p.h);
      if (filled(p) && pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1) return true;
      const c = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
      return c.some((a, i) => distSeg(pt, a, c[(i + 1) % 4]) <= tol);
    }
    case "ellipse":
    case "arc": {
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2, rx = Math.abs(p.w / 2) || 0.01, ry = Math.abs(p.h / 2) || 0.01;
      const k = Math.hypot((pt.x - cx) / rx, (pt.y - cy) / ry);
      if (p.t === "ellipse" && filled(p) && k <= 1) return true;
      const ring = Math.abs(k - 1) * Math.min(rx, ry) <= tol;
      if (!ring) return false;
      return p.t === "ellipse" || angleIn(qetAngle(pt, p), p.start, p.angle);
    }
    case "polygon": {
      if (p.closed && filled(p) && inPoly(pt, p.pts)) return true;
      for (let i = 0; i < p.pts.length - 1; i++) if (distSeg(pt, p.pts[i], p.pts[i + 1]) <= tol) return true;
      return p.closed && p.pts.length > 2 && distSeg(pt, p.pts[p.pts.length - 1], p.pts[0]) <= tol;
    }
    case "text":
    case "dyntext": {
      const b = primBounds(p, { dyn: true });
      return !!b && pt.x >= b.x - tol && pt.x <= b.x + b.w + tol && pt.y >= b.y - tol && pt.y <= b.y + b.h + tol;
    }
  }
}

export function hitPin(pin: PinDef, pt: Pt, tol: number): boolean {
  const v = stubVec(pin.orient);
  return distSeg(pt, pin, { x: pin.x + v.x * 4, y: pin.y + v.y * 4 }) <= tol + 1.5;
}

export const stubVec = (o: Orient): Pt => (o === "n" ? { x: 0, y: 1 } : o === "s" ? { x: 0, y: -1 } : o === "e" ? { x: -1, y: 0 } : { x: 1, y: 0 });
export const outVec = (o: Orient): Pt => ({ x: -stubVec(o).x, y: -stubVec(o).y });

export function boundsOfPrim(p: EdPrim): Rect | null {
  return primBounds(p, { dyn: true });
}

export function selectionBounds(prims: EdPrim[], pins: PinDef[], sel: Set<string>): Rect | null {
  let r: Rect | null = null;
  for (const p of prims) if (sel.has(p.id)) r = unionR(r, boundsOfPrim(p));
  for (const p of pins) if (sel.has(p.id)) r = unionR(r, pinBounds(p));
  return r;
}

/* ------------------------------------------------------------------ */
/* Transforms                                                          */
/* ------------------------------------------------------------------ */

export function translatePrim(p: Prim, dx: number, dy: number): void {
  switch (p.t) {
    case "line":
      p.x1 = r1(p.x1 + dx);
      p.y1 = r1(p.y1 + dy);
      p.x2 = r1(p.x2 + dx);
      p.y2 = r1(p.y2 + dy);
      break;
    case "polygon":
      p.pts = p.pts.map((q) => ({ x: r1(q.x + dx), y: r1(q.y + dy) }));
      break;
    default:
      p.x = r1(p.x + dx);
      p.y = r1(p.y + dy);
  }
}

const rotPt = (q: Pt, c: Pt, dir: 1 | -1): Pt => ({ x: r1(c.x - dir * (q.y - c.y)), y: r1(c.y + dir * (q.x - c.x)) }); // dir 1 = 90° clockwise on screen

/** Rotate by 90° (dir=1 clockwise) about c. */
export function rotatePrim(p: Prim, c: Pt, dir: 1 | -1): void {
  switch (p.t) {
    case "line": {
      const a = rotPt({ x: p.x1, y: p.y1 }, c, dir), b = rotPt({ x: p.x2, y: p.y2 }, c, dir);
      Object.assign(p, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      break;
    }
    case "polygon":
      p.pts = p.pts.map((q) => rotPt(q, c, dir));
      break;
    case "rect":
    case "ellipse":
    case "arc": {
      const cc = rotPt({ x: p.x + p.w / 2, y: p.y + p.h / 2 }, c, dir);
      const w = p.h, h = p.w;
      p.x = r1(cc.x - w / 2);
      p.y = r1(cc.y - h / 2);
      p.w = w;
      p.h = h;
      if (p.t === "rect") [p.rx, p.ry] = [p.ry, p.rx];
      if (p.t === "arc") p.start = normDeg(p.start - 90 * dir);
      break;
    }
    case "text":
    case "dyntext": {
      const q = rotPt({ x: p.x, y: p.y }, c, dir);
      p.x = q.x;
      p.y = q.y;
      p.rotation = normDeg(p.rotation + 90 * dir);
      break;
    }
  }
}

export function normDeg(d: number): number {
  let v = d % 360;
  if (v < 0) v += 360;
  return r1(v);
}

/** Mirror horizontally (axis x = cx) or vertically (axis y = cy). */
export function mirrorPrim(p: Prim, axis: "h" | "v", c: Pt): void {
  const mx = (x: number) => r1(2 * c.x - x), my = (y: number) => r1(2 * c.y - y);
  switch (p.t) {
    case "line":
      if (axis === "h") (p.x1 = mx(p.x1)), (p.x2 = mx(p.x2));
      else (p.y1 = my(p.y1)), (p.y2 = my(p.y2));
      break;
    case "polygon":
      p.pts = p.pts.map((q) => (axis === "h" ? { x: mx(q.x), y: q.y } : { x: q.x, y: my(q.y) }));
      break;
    case "rect":
    case "ellipse":
    case "arc":
      if (axis === "h") p.x = r1(2 * c.x - p.x - p.w);
      else p.y = r1(2 * c.y - p.y - p.h);
      if (p.t === "arc") p.start = normDeg(axis === "h" ? 180 - p.start - p.angle : -p.start - p.angle);
      break;
    case "text":
    case "dyntext": {
      const b = primBounds(p, { dyn: true });
      if (!b) break;
      if (axis === "h") p.x = r1(p.x + (2 * c.x - (b.x + b.w) - b.x));
      else p.y = r1(p.y + (2 * c.y - (b.y + b.h) - b.y));
      break;
    }
  }
}

const ORD: Orient[] = ["n", "e", "s", "w"];
export function rotatePin(pin: PinDef, c: Pt, dir: 1 | -1) {
  const q = rotPt(pin, c, dir);
  pin.x = q.x;
  pin.y = q.y;
  pin.orient = ORD[(ORD.indexOf(pin.orient) + (dir === 1 ? 1 : 3)) % 4];
}
export function mirrorPin(pin: PinDef, axis: "h" | "v", c: Pt) {
  if (axis === "h") {
    pin.x = r1(2 * c.x - pin.x);
    if (pin.orient === "e" || pin.orient === "w") pin.orient = pin.orient === "e" ? "w" : "e";
  } else {
    pin.y = r1(2 * c.y - pin.y);
    if (pin.orient === "n" || pin.orient === "s") pin.orient = pin.orient === "n" ? "s" : "n";
  }
}

/* ------------------------------------------------------------------ */
/* Handles                                                             */
/* ------------------------------------------------------------------ */

export type Handle = { key: string; x: number; y: number; kind: "corner" | "edge" | "point" | "angle" };

export function handlesOf(p: EdPrim): Handle[] {
  switch (p.t) {
    case "line":
      return [
        { key: "p1", x: p.x1, y: p.y1, kind: "point" },
        { key: "p2", x: p.x2, y: p.y2, kind: "point" },
      ];
    case "polygon":
      return p.pts.map((q, i) => ({ key: `v${i}`, x: q.x, y: q.y, kind: "point" as const }));
    case "rect":
    case "ellipse":
    case "arc": {
      const x0 = p.x, y0 = p.y, x1 = p.x + p.w, y1 = p.y + p.h, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
      const hs: Handle[] = [
        { key: "nw", x: x0, y: y0, kind: "corner" },
        { key: "n", x: xm, y: y0, kind: "edge" },
        { key: "ne", x: x1, y: y0, kind: "corner" },
        { key: "e", x: x1, y: ym, kind: "edge" },
        { key: "se", x: x1, y: y1, kind: "corner" },
        { key: "s", x: xm, y: y1, kind: "edge" },
        { key: "sw", x: x0, y: y1, kind: "corner" },
        { key: "w", x: x0, y: ym, kind: "edge" },
      ];
      if (p.t === "arc") {
        const a = ellipsePoint(p, p.start), b = ellipsePoint(p, p.start + p.angle);
        hs.push({ key: "a0", x: a.x, y: a.y, kind: "angle" }, { key: "a1", x: b.x, y: b.y, kind: "angle" });
      }
      return hs;
    }
    default:
      return [];
  }
}

/** Apply a handle drag (pt already snapped). `orig` is the primitive at gesture start. */
export function applyHandle(p: Prim, orig: Prim, key: string, pt: Pt, shift: boolean): void {
  if (p.t === "line" && orig.t === "line") {
    let q = pt;
    if (shift) {
      const o = key === "p1" ? { x: orig.x2, y: orig.y2 } : { x: orig.x1, y: orig.y1 };
      q = Math.abs(pt.x - o.x) > Math.abs(pt.y - o.y) ? { x: pt.x, y: o.y } : { x: o.x, y: pt.y };
    }
    if (key === "p1") (p.x1 = q.x), (p.y1 = q.y);
    else (p.x2 = q.x), (p.y2 = q.y);
    return;
  }
  if (p.t === "polygon" && orig.t === "polygon") {
    const i = Number(key.slice(1));
    p.pts = orig.pts.map((q, k) => (k === i ? { x: pt.x, y: pt.y } : q));
    return;
  }
  if ((p.t === "rect" || p.t === "ellipse" || p.t === "arc") && (orig.t === "rect" || orig.t === "ellipse" || orig.t === "arc")) {
    if (p.t === "arc" && orig.t === "arc" && (key === "a0" || key === "a1")) {
      let a = qetAngle(pt, orig);
      if (shift) a = Math.round(a / 15) * 15;
      const sign = orig.angle < 0 ? -1 : 1;
      const wrap = (v: number) => {
        let x = ((v % 360) + 360) % 360;
        if (sign < 0) x = x - 360;
        if (x === 0) x = 360 * sign;
        return r1(x);
      };
      if (key === "a0") {
        const end = orig.start + orig.angle;
        p.start = normDeg(a);
        p.angle = wrap(end - a);
      } else p.angle = wrap(a - orig.start);
      return;
    }
    let x0 = orig.x, y0 = orig.y, x1 = orig.x + orig.w, y1 = orig.y + orig.h;
    if (key.includes("w")) x0 = pt.x;
    if (key.includes("e")) x1 = pt.x;
    if (key.includes("n")) y0 = pt.y;
    if (key.includes("s")) y1 = pt.y;
    if (shift && key.length === 2) {
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      if (key.includes("w")) x0 = x1 - s * Math.sign(x1 - x0 || 1);
      else x1 = x0 + s * Math.sign(x1 - x0 || 1);
      if (key.includes("n")) y0 = y1 - s * Math.sign(y1 - y0 || 1);
      else y1 = y0 + s * Math.sign(y1 - y0 || 1);
    }
    p.x = r1(Math.min(x0, x1));
    p.y = r1(Math.min(y0, y1));
    p.w = r1(Math.abs(x1 - x0));
    p.h = r1(Math.abs(y1 - y0));
    if (p.t === "arc" && orig.t === "arc") {
      // keep angles consistent when flipped
      const fx = x1 < x0, fy = y1 < y0;
      if (fx || fy) {
        let s = orig.start, a = orig.angle;
        if (fx) (s = 180 - s - a);
        if (fy) (s = -s - a);
        p.start = normDeg(s);
        p.angle = a;
      }
    }
  }
}

/** Auto pin orientation: the side of the body box the point is nearest to / outside of. */
export function autoOrient(pt: Pt, body: Rect | null): Orient {
  if (!body || (body.w < 1 && body.h < 1)) return "w";
  const cx = body.x + body.w / 2, cy = body.y + body.h / 2;
  const dxn = (pt.x - cx) / Math.max(body.w / 2, 1), dyn = (pt.y - cy) / Math.max(body.h / 2, 1);
  if (Math.abs(dxn) >= Math.abs(dyn)) return dxn >= 0 ? "e" : "w";
  return dyn >= 0 ? "s" : "n";
}

export function nextPinNumber(pins: PinDef[]): string {
  let max = 0;
  let prefix = "";
  for (const p of pins) {
    const m = /^([A-Za-z]*)(\d+)$/.exec(p.number.trim());
    if (m && Number(m[2]) >= max) {
      max = Number(m[2]);
      prefix = m[1];
    }
  }
  return `${prefix}${max + 1}`;
}

export function clonePrimShifted<T extends Prim>(p: T, dx: number, dy: number): T {
  const c = JSON.parse(JSON.stringify(p)) as T;
  translatePrim(c, dx, dy);
  if (c.t === "dyntext" && c.uuid) (c as Extract<Prim, { t: "dyntext" }>).uuid = crypto.randomUUID?.() ?? undefined;
  return c;
}

/* ------------------------------------------------------------------ */
/* Object snapping                                                     */
/* ------------------------------------------------------------------ */

export type OSnapKind = "pin" | "end" | "mid" | "center" | "quadrant" | "on" | "grid" | "free";
export type OSnap = { p: Pt; kind: OSnapKind };

/** Characteristic points of the drawing: line / polygon ends and vertices, midpoints, centres, pins. */
export function snapPoints(prims: EdPrim[], pins: { id: string; x: number; y: number }[], exclude?: string): OSnap[] {
  const out: OSnap[] = [];
  const add = (x: number, y: number, kind: OSnapKind) => out.push({ p: { x, y }, kind });
  for (const pin of pins) if (pin.id !== exclude) add(pin.x, pin.y, "pin");
  for (const p of prims) {
    if (p.id === exclude) continue;
    switch (p.t) {
      case "line":
        add(p.x1, p.y1, "end");
        add(p.x2, p.y2, "end");
        add((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, "mid");
        break;
      case "polygon":
        p.pts.forEach((q, i) => {
          add(q.x, q.y, "end");
          const n = p.pts[i + 1] ?? (p.closed ? p.pts[0] : null);
          if (n) add((q.x + n.x) / 2, (q.y + n.y) / 2, "mid");
        });
        break;
      case "rect": {
        const x0 = p.x, y0 = p.y, x1 = p.x + p.w, y1 = p.y + p.h;
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) add(x, y, "end");
        for (const [x, y] of [[(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2]]) add(x, y, "mid");
        add((x0 + x1) / 2, (y0 + y1) / 2, "center");
        break;
      }
      case "ellipse":
      case "arc": {
        const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
        add(cx, cy, "center");
        if (p.t === "ellipse") for (const [x, y] of [[cx, p.y], [p.x + p.w, cy], [cx, p.y + p.h], [p.x, cy]]) add(x, y, "quadrant");
        else {
          add(ellipsePoint(p, p.start).x, ellipsePoint(p, p.start).y, "end");
          const e = ellipsePoint(p, p.start + p.angle);
          add(e.x, e.y, "end");
        }
        break;
      }
    }
  }
  return out;
}

/** Nearest point lying on a line / polygon / rectangle edge (for "on line" snapping). */
export function nearestOnPrims(prims: EdPrim[], pt: Pt, exclude?: string): { p: Pt; d: number } | null {
  let best: { p: Pt; d: number } | null = null;
  const seg = (a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(pt.x - q.x, pt.y - q.y);
    if (!best || d < best.d) best = { p: q, d };
  };
  for (const p of prims) {
    if (p.id === exclude) continue;
    if (p.t === "line") seg({ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 });
    else if (p.t === "polygon") p.pts.forEach((q, i) => (p.pts[i + 1] ? seg(q, p.pts[i + 1]) : p.closed && p.pts.length > 2 ? seg(q, p.pts[0]) : null));
    else if (p.t === "rect") {
      const c = [{ x: p.x, y: p.y }, { x: p.x + p.w, y: p.y }, { x: p.x + p.w, y: p.y + p.h }, { x: p.x, y: p.y + p.h }];
      c.forEach((q, i) => seg(q, c[(i + 1) % 4]));
    }
  }
  return best;
}
