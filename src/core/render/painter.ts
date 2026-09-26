import type { Mat } from "../geometry";

/**
 * Minimal retained path format. Built once (e.g. per compiled symbol) and cached by the
 * Canvas backend as Path2D keyed by object identity.
 */
export type PathOp =
  | [op: "M", x: number, y: number]
  | [op: "L", x: number, y: number]
  | [op: "Z"]
  | [op: "E", cx: number, cy: number, rx: number, ry: number] // full ellipse
  | [op: "A", cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, ccw: boolean] // elliptic arc, radians, screen angles
  | [op: "R", x: number, y: number, w: number, h: number]
  | [op: "RR", x: number, y: number, w: number, h: number, rx: number, ry: number];

export type PathData = { ops: PathOp[] };

export type StrokeStyle = {
  color: string;
  width: number;
  dash?: number[] | null;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  /** minimum on-screen width in device-independent px (canvas only) */
  minPx?: number;
  alpha?: number;
};

export type TextDraw = {
  text: string;
  x: number;
  y: number;
  size: number; // px (scene units)
  font: string;
  weight?: number;
  italic?: boolean;
  color: string;
  align?: "left" | "center" | "right";
  baseline?: "top" | "middle" | "alphabetic" | "bottom";
  rotation?: number; // degrees clockwise, about (x,y)
  background?: string | null;
  alpha?: number;
};

export interface Painter {
  readonly kind: "canvas" | "svg" | "pdf" | "dxf";
  save(): void;
  restore(): void;
  /** pre-multiply current transform */
  transform(m: Mat): void;
  stroke(path: PathData, s: StrokeStyle): void;
  /** optional batched stroke of many paths with one style (canvas: single native stroke) */
  strokeMany?(paths: PathData[], s: StrokeStyle): void;
  fill(path: PathData, color: string, alpha?: number): void;
  text(t: TextDraw): void;
  measure(text: string, size: number, font: string, weight?: number): number;
  /** hint: the current scale in device px per scene unit (canvas only) */
  scale(): number;
  /** optional grouping for SVG/DXF layers */
  begin?(layer: string, attrs?: Record<string, string>): void;
  end?(): void;
}

export class PathBuilder {
  ops: PathOp[] = [];
  M(x: number, y: number) {
    this.ops.push(["M", x, y]);
    return this;
  }
  L(x: number, y: number) {
    this.ops.push(["L", x, y]);
    return this;
  }
  Z() {
    this.ops.push(["Z"]);
    return this;
  }
  E(cx: number, cy: number, rx: number, ry: number) {
    this.ops.push(["E", cx, cy, rx, ry]);
    return this;
  }
  A(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, ccw: boolean) {
    this.ops.push(["A", cx, cy, rx, ry, a0, a1, ccw]);
    return this;
  }
  R(x: number, y: number, w: number, h: number) {
    this.ops.push(["R", x, y, w, h]);
    return this;
  }
  RR(x: number, y: number, w: number, h: number, rx: number, ry: number) {
    this.ops.push(["RR", x, y, w, h, rx, ry]);
    return this;
  }
  poly(pts: { x: number; y: number }[], closed = false) {
    pts.forEach((p, i) => (i ? this.L(p.x, p.y) : this.M(p.x, p.y)));
    if (closed) this.Z();
    return this;
  }
  build(): PathData {
    return { ops: this.ops };
  }
}

export const DASHES: Record<string, number[] | null> = {
  solid: null,
  normal: null,
  dashed: [6, 3],
  dotted: [1, 2.5],
  dashdot: [6, 2.5, 1, 2.5],
  dashdotted: [6, 2.5, 1, 2.5],
};

/** Point on ellipse for a screen angle (radians, measured clockwise because y is down). */
export const ellipsePt = (cx: number, cy: number, rx: number, ry: number, a: number) => ({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });

/** Convert a path to SVG `d` — shared by SVG and PDF backends. */
export function pathToSvgD(p: PathData, fmt: (n: number) => string = (n) => String(Math.round(n * 1000) / 1000)): string {
  const out: string[] = [];
  for (const op of p.ops) {
    switch (op[0]) {
      case "M":
        out.push(`M${fmt(op[1])} ${fmt(op[2])}`);
        break;
      case "L":
        out.push(`L${fmt(op[1])} ${fmt(op[2])}`);
        break;
      case "Z":
        out.push("Z");
        break;
      case "R":
        out.push(`M${fmt(op[1])} ${fmt(op[2])}h${fmt(op[3])}v${fmt(op[4])}h${fmt(-op[3])}Z`);
        break;
      case "RR": {
        const [, x, y, w, h] = op;
        const rx = Math.min(op[5], w / 2), ry = Math.min(op[6], h / 2);
        if (!rx || !ry) {
          out.push(`M${fmt(x)} ${fmt(y)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}Z`);
          break;
        }
        out.push(
          `M${fmt(x + rx)} ${fmt(y)}H${fmt(x + w - rx)}A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + w)} ${fmt(y + ry)}V${fmt(y + h - ry)}A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + w - rx)} ${fmt(y + h)}H${fmt(x + rx)}A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x)} ${fmt(y + h - ry)}V${fmt(y + ry)}A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + rx)} ${fmt(y)}Z`,
        );
        break;
      }
      case "E": {
        const [, cx, cy, rx, ry] = op;
        out.push(`M${fmt(cx - rx)} ${fmt(cy)}A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx + rx)} ${fmt(cy)}A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx - rx)} ${fmt(cy)}Z`);
        break;
      }
      case "A": {
        const [, cx, cy, rx, ry, a0, a1, ccw] = op;
        let sweep = a1 - a0;
        if (ccw && sweep > 0) sweep -= Math.PI * 2;
        if (!ccw && sweep < 0) sweep += Math.PI * 2;
        const s = ellipsePt(cx, cy, rx, ry, a0);
        // split in <=180° chunks to keep SVG arcs unambiguous
        const n = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI));
        out.push(`M${fmt(s.x)} ${fmt(s.y)}`);
        for (let i = 1; i <= n; i++) {
          const e = ellipsePt(cx, cy, rx, ry, a0 + (sweep * i) / n);
          out.push(`A${fmt(rx)} ${fmt(ry)} 0 0 ${sweep > 0 ? 1 : 0} ${fmt(e.x)} ${fmt(e.y)}`);
        }
        break;
      }
    }
  }
  return out.join("");
}

/** Flatten a path into polylines (for DXF & hit tests). */
export function flattenPath(p: PathData, seg = 24): { pts: { x: number; y: number }[]; closed: boolean }[] {
  const res: { pts: { x: number; y: number }[]; closed: boolean }[] = [];
  let cur: { pts: { x: number; y: number }[]; closed: boolean } | null = null;
  const start = (x: number, y: number) => {
    cur = { pts: [{ x, y }], closed: false };
    res.push(cur);
  };
  for (const op of p.ops) {
    switch (op[0]) {
      case "M":
        start(op[1], op[2]);
        break;
      case "L":
        if (!cur) start(op[1], op[2]);
        else (cur as { pts: { x: number; y: number }[] }).pts.push({ x: op[1], y: op[2] });
        break;
      case "Z":
        if (cur) (cur as { closed: boolean }).closed = true;
        cur = null;
        break;
      case "R":
      case "RR": {
        const [, x, y, w, h] = op;
        res.push({ pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true });
        cur = null;
        break;
      }
      case "E": {
        const [, cx, cy, rx, ry] = op;
        const pts = [];
        for (let i = 0; i < seg * 2; i++) pts.push(ellipsePt(cx, cy, rx, ry, (i / (seg * 2)) * Math.PI * 2));
        res.push({ pts, closed: true });
        cur = null;
        break;
      }
      case "A": {
        const [, cx, cy, rx, ry, a0, a1, ccw] = op;
        let sweep = a1 - a0;
        if (ccw && sweep > 0) sweep -= Math.PI * 2;
        if (!ccw && sweep < 0) sweep += Math.PI * 2;
        const n = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * seg * 2));
        const pts = [];
        for (let i = 0; i <= n; i++) pts.push(ellipsePt(cx, cy, rx, ry, a0 + (sweep * i) / n));
        res.push({ pts, closed: false });
        cur = null;
        break;
      }
    }
  }
  return res;
}
