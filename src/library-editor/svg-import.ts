/**
 * SVG → QElectroTech primitives (browser only: uses DOMParser).
 * Supports path (M L H V C S Q T A Z, absolute & relative), rect, circle, ellipse, line, polyline,
 * polygon, nested <g>/<svg>/<a> with transforms. Curves are flattened into polylines; axis-aligned
 * rects/circles/ellipses stay native when the transform has no rotation/skew.
 * The result is scaled to fit `size` units and centred on the origin.
 */
import type { Prim, PrimStyle, Pt } from "@/core/model";
import { QET_COLORS } from "@/core/styles";

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const ap = (m: M, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

export function parseTransform(s: string | null): M {
  let m: M = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const a = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t: M = I;
    switch (r[1]) {
      case "matrix":
        if (a.length === 6) t = a as M;
        break;
      case "translate":
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const rad = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(rad), sn = Math.sin(rad);
        const rot: M = [c, sn, -sn, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]);
        else t = rot;
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

type Shape = { kind: "poly"; pts: Pt[]; closed: boolean; fill: string | null; stroke: string | null } | { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number; fill: string | null; stroke: string | null };

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Flatten an SVG path `d` into polylines (user space). */
export function flattenPathD(d: string, seg = 12): { pts: Pt[]; closed: boolean }[] {
  const out: { pts: Pt[]; closed: boolean }[] = [];
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let cur: Pt = { x: 0, y: 0 }, start: Pt = { x: 0, y: 0 };
  let lastCtrl: Pt | null = null;
  let lastCmd = "";
  let sub: { pts: Pt[]; closed: boolean } | null = null;
  const n = () => Number(toks[i++]);
  const isNum = () => i < toks.length && !/^[A-Za-z]$/.test(toks[i]);
  const push = (p: Pt) => {
    if (!sub) {
      sub = { pts: [cur], closed: false };
      out.push(sub);
    }
    sub.pts.push(p);
    cur = p;
  };
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const P = (x: number, y: number): Pt => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    switch (C) {
      case "M": {
        const p = P(n(), n());
        cur = p;
        start = p;
        sub = { pts: [p], closed: false };
        out.push(sub);
        cmd = rel ? "l" : "L";
        lastCtrl = null;
        break;
      }
      case "L":
        push(P(n(), n()));
        lastCtrl = null;
        break;
      case "H":
        push({ x: rel ? cur.x + n() : n(), y: cur.y });
        lastCtrl = null;
        break;
      case "V":
        push({ x: cur.x, y: rel ? cur.y + n() : n() });
        lastCtrl = null;
        break;
      case "C":
      case "S": {
        let c1: Pt;
        if (C === "C") c1 = P(n(), n());
        else c1 = lastCtrl && /[CS]/.test(lastCmd) ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
        const c2 = P(n(), n());
        const e = P(n(), n());
        const s0 = cur;
        for (let k = 1; k <= seg; k++) {
          const t = k / seg, u = 1 - t;
          push({ x: u * u * u * s0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * e.x, y: u * u * u * s0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * e.y });
        }
        lastCtrl = c2;
        break;
      }
      case "Q":
      case "T": {
        let c: Pt;
        if (C === "Q") c = P(n(), n());
        else c = lastCtrl && /[QT]/.test(lastCmd) ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
        const e = P(n(), n());
        const s0 = cur;
        for (let k = 1; k <= seg; k++) {
          const t = k / seg, u = 1 - t;
          push({ x: u * u * s0.x + 2 * u * t * c.x + t * t * e.x, y: u * u * s0.y + 2 * u * t * c.y + t * t * e.y });
        }
        lastCtrl = c;
        break;
      }
      case "A": {
        const rx0 = Math.abs(n()), ry0 = Math.abs(n()), phi = (n() * Math.PI) / 180, large = n() !== 0, sweep = n() !== 0;
        const e = P(n(), n());
        arcTo(cur, e, rx0, ry0, phi, large, sweep, seg).forEach(push);
        lastCtrl = null;
        break;
      }
      case "Z": {
        if (sub) {
          (sub as { closed: boolean }).closed = true;
        }
        cur = start;
        sub = null;
        lastCtrl = null;
        break;
      }
      default:
        i++;
    }
    lastCmd = C;
    // implicit repetition
    if (C !== "Z" && isNum()) continue;
  }
  return out.filter((s) => s.pts.length >= 2);
}

function arcTo(p0: Pt, p1: Pt, rx: number, ry: number, phi: number, large: boolean, sweep: boolean, seg: number): Pt[] {
  if (!rx || !ry) return [p1];
  const c = Math.cos(phi), s = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = c * dx + s * dy, y1 = -s * dx + c * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = c * cx1 - s * cy1 + (p0.x + p1.x) / 2, cy = s * cx1 + c * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(2, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * seg));
  const pts: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const t = t1 + (dt * k) / n;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    pts.push({ x: c * x - s * y + cx, y: s * x + c * y + cy });
  }
  return pts;
}

function styleOf(el: Element, inherited: { fill: string | null; stroke: string | null }) {
  const st = el.getAttribute("style") ?? "";
  const prop = (k: string) => new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([^;]+)`).exec(st)?.[1]?.trim() ?? el.getAttribute(k);
  const f = prop("fill");
  const s = prop("stroke");
  return { fill: f === null ? inherited.fill : f === "none" || f === "transparent" ? null : f, stroke: s === null ? inherited.stroke : s === "none" || s === "transparent" ? null : s };
}

function parseColor(c: string): [number, number, number] | null {
  const s = c.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgb) {
    const v = rgb[1].split(",").map((x) => parseFloat(x));
    return [v[0], v[1], v[2]];
  }
  const named: Record<string, [number, number, number]> = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], yellow: [255, 255, 0], orange: [255, 165, 0] };
  return named[s] ?? null;
}

/** Nearest QET named colour. */
export function nearestQetColor(c: string | null): string {
  if (!c) return "black";
  const rgb = parseColor(c);
  if (!rgb) return "black";
  let best = "black", bd = Infinity;
  for (const [name, hex] of Object.entries(QET_COLORS)) {
    if (name === "none") continue;
    const q = parseColor(hex)!;
    const d = (q[0] - rgb[0]) ** 2 + (q[1] - rgb[1]) ** 2 + (q[2] - rgb[2]) ** 2;
    if (d < bd) (bd = d), (best = name);
  }
  return best;
}

const num = (el: Element, k: string, d = 0) => {
  const v = parseFloat(el.getAttribute(k) ?? "");
  return Number.isFinite(v) ? v : d;
};

function collect(el: Element, m: M, inh: { fill: string | null; stroke: string | null }, out: Shape[]) {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, "");
  if (["defs", "clippath", "mask", "symbol", "style", "title", "desc", "metadata", "pattern", "marker", "text", "image"].includes(tag)) return;
  const mm = mul(m, parseTransform(el.getAttribute("transform")));
  const st = styleOf(el, inh);
  if (el.getAttribute("display") === "none" || /display\s*:\s*none/.test(el.getAttribute("style") ?? "")) return;
  const axis = Math.abs(mm[1]) < 1e-9 && Math.abs(mm[2]) < 1e-9;
  const polyOut = (pts: Pt[], closed: boolean) => out.push({ kind: "poly", pts: pts.map((p) => ap(mm, p)), closed, fill: st.fill, stroke: st.stroke });
  switch (tag) {
    case "svg":
    case "g":
    case "a":
    case "switch":
      for (const c of Array.from(el.children)) collect(c, tag === "svg" && el !== el.ownerDocument.documentElement ? mul(mm, [1, 0, 0, 1, num(el, "x"), num(el, "y")]) : mm, st, out);
      return;
    case "rect": {
      const x = num(el, "x"), y = num(el, "y"), w = num(el, "width"), h = num(el, "height");
      if (w <= 0 || h <= 0) return;
      if (axis) {
        const a = ap(mm, { x, y }), b = ap(mm, { x: x + w, y: y + h });
        out.push({ kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), fill: st.fill, stroke: st.stroke });
      } else
        polyOut(
          [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ],
          true,
        );
      return;
    }
    case "circle":
    case "ellipse": {
      const cx = num(el, "cx"), cy = num(el, "cy");
      const rx = tag === "circle" ? num(el, "r") : num(el, "rx"), ry = tag === "circle" ? num(el, "r") : num(el, "ry");
      if (rx <= 0 || ry <= 0) return;
      if (axis) {
        const a = ap(mm, { x: cx - rx, y: cy - ry }), b = ap(mm, { x: cx + rx, y: cy + ry });
        out.push({ kind: "ellipse", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), fill: st.fill, stroke: st.stroke });
      } else {
        const pts: Pt[] = [];
        for (let k = 0; k < 48; k++) pts.push({ x: cx + rx * Math.cos((k / 48) * Math.PI * 2), y: cy + ry * Math.sin((k / 48) * Math.PI * 2) });
        polyOut(pts, true);
      }
      return;
    }
    case "line":
      polyOut(
        [
          { x: num(el, "x1"), y: num(el, "y1") },
          { x: num(el, "x2"), y: num(el, "y2") },
        ],
        false,
      );
      return;
    case "polyline":
    case "polygon": {
      const v = (el.getAttribute("points") ?? "").match(NUM)?.map(Number) ?? [];
      const pts: Pt[] = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push({ x: v[k], y: v[k + 1] });
      if (pts.length >= 2) polyOut(pts, tag === "polygon");
      return;
    }
    case "path":
      for (const s of flattenPathD(el.getAttribute("d") ?? "")) polyOut(s.pts, s.closed);
      return;
    default:
      for (const c of Array.from(el.children)) collect(c, mm, st, out);
  }
}

/** Douglas–Peucker simplification. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const d2 = (p: Pt, a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
  };
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = d2(pts[i], pts[a], pts[b]);
      if (d > md) (md = d), (mi = i);
    }
    if (mi >= 0 && md > eps * eps) {
      keep[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export type SvgImportResult = { prims: Prim[]; count: number; warnings: string[] };

export function svgToPrims(svgText: string, size = 60): SvgImportResult {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase().replace(/^svg:/, "") !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("Not a valid SVG file");
  const warnings: string[] = [];
  if (root.getElementsByTagName("text").length) warnings.push("Text in the SVG was skipped — add texts with the text tool.");
  if (root.getElementsByTagName("image").length) warnings.push("Embedded bitmaps were skipped.");
  const shapes: Shape[] = [];
  collect(root, I, { fill: "black", stroke: null }, shapes);
  if (!shapes.length) throw new Error("No drawable shapes found in the SVG");
  // bounds
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  for (const s of shapes)
    if (s.kind === "poly") s.pts.forEach(add);
    else {
      add({ x: s.x, y: s.y });
      add({ x: s.x + s.w, y: s.y + s.h });
    }
  const k = size / Math.max(x1 - x0, y1 - y0, 1e-6);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const T = (p: Pt): Pt => ({ x: Math.round((p.x - cx) * k * 10) / 10, y: Math.round((p.y - cy) * k * 10) / 10 });
  const prims: Prim[] = [];
  for (const s of shapes) {
    const filled = s.fill && s.kind !== "poly" ? true : !!s.fill && s.kind === "poly" && s.closed;
    const style: PrimStyle = {
      lineStyle: "normal",
      lineWeight: s.stroke ? "normal" : filled ? "none" : "normal",
      filling: filled ? nearestQetColor(s.fill) : "none",
      color: nearestQetColor(s.stroke ?? s.fill),
    };
    if (style.filling === "white" && !s.stroke) continue; // background fills
    if (s.kind === "poly") {
      const pts = simplify(s.pts.map(T), 0.15);
      const dedup = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
      if (dedup.length < 2) continue;
      if (dedup.length === 2 && !s.closed) prims.push({ t: "line", x1: dedup[0].x, y1: dedup[0].y, x2: dedup[1].x, y2: dedup[1].y, end1: "none", end2: "none", len1: 1.5, len2: 1.5, style });
      else {
        const closed = s.closed || (dedup.length > 2 && dedup[0].x === dedup[dedup.length - 1].x && dedup[0].y === dedup[dedup.length - 1].y);
        prims.push({ t: "polygon", pts: closed && dedup.length > 2 && dedup[0].x === dedup[dedup.length - 1].x && dedup[0].y === dedup[dedup.length - 1].y ? dedup.slice(0, -1) : dedup, closed, style });
      }
    } else {
      const a = T({ x: s.x, y: s.y }), b = T({ x: s.x + s.w, y: s.y + s.h });
      const r = { x: a.x, y: a.y, w: Math.round((b.x - a.x) * 10) / 10, h: Math.round((b.y - a.y) * 10) / 10 };
      if (s.kind === "rect") prims.push({ t: "rect", ...r, rx: 0, ry: 0, style });
      else prims.push({ t: "ellipse", ...r, style });
    }
  }
  if (prims.length > 2000) warnings.push(`The drawing has ${prims.length} shapes — consider simplifying it.`);
  return { prims, count: prims.length, warnings };
}
