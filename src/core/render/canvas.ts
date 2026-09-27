import type { Mat } from "../geometry";
import { mulMat } from "../geometry";
import type { ImageDraw, Painter, PathData, StrokeStyle, TextDraw } from "./painter";

/** Decoded images by key; listeners are told when one finishes loading so views can repaint. */
const images = new Map<string, HTMLImageElement | "error">();
export const imageLoadListeners = new Set<() => void>();
function imageFor(d: ImageDraw): HTMLImageElement | null {
  const hit = images.get(d.key);
  if (hit) return hit === "error" || !hit.complete ? null : hit;
  if (typeof Image === "undefined") return null;
  const img = new Image();
  images.set(d.key, img);
  img.onload = () => imageLoadListeners.forEach((f) => f());
  img.onerror = () => images.set(d.key, "error");
  img.src = `data:${d.mime};base64,${d.data}`;
  return img.complete && img.naturalWidth ? img : null;
}

const pathCache = new WeakMap<PathData, Path2D>();
function toPath2D(p: PathData): Path2D {
  let c = pathCache.get(p);
  if (c) return c;
  c = new Path2D();
  for (const op of p.ops) {
    switch (op[0]) {
      case "M":
        c.moveTo(op[1], op[2]);
        break;
      case "L":
        c.lineTo(op[1], op[2]);
        break;
      case "Z":
        c.closePath();
        break;
      case "R":
        c.rect(op[1], op[2], op[3], op[4]);
        break;
      case "RR":
        if (op[5] > 0 && op[6] > 0 && (c as Path2D & { roundRect?: unknown }).roundRect) c.roundRect(op[1], op[2], op[3], op[4], Math.min(op[5], op[6]));
        else c.rect(op[1], op[2], op[3], op[4]);
        break;
      case "E":
        c.moveTo(op[1] + op[3], op[2]);
        c.ellipse(op[1], op[2], Math.abs(op[3]), Math.abs(op[4]), 0, 0, Math.PI * 2);
        break;
      case "A": {
        const [, cx, cy, rx, ry, a0, a1, ccw] = op;
        c.moveTo(cx + rx * Math.cos(a0), cy + ry * Math.sin(a0));
        c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, a0, a1, ccw);
        break;
      }
    }
  }
  pathCache.set(p, c);
  return c;
}

const measureCache = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
function mctx() {
  if (measureCtx) return measureCtx;
  if (typeof OffscreenCanvas !== "undefined") measureCtx = new OffscreenCanvas(1, 1).getContext("2d");
  else if (typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

export function fontString(size: number, font: string, weight = 400, italic = false) {
  return `${italic ? "italic " : ""}${weight} ${size}px ${font}`;
}

export function measureText(text: string, size: number, font: string, weight = 400): number {
  // measure at 100px and scale: one cache entry per string/font
  const key = weight + "|" + font + "|" + text;
  let w = measureCache.get(key);
  if (w === undefined) {
    const c = mctx();
    if (c) {
      c.font = fontString(100, font, weight);
      w = c.measureText(text).width / 100;
    } else w = text.length * 0.55;
    if (measureCache.size > 20000) measureCache.clear();
    measureCache.set(key, w);
  }
  return w * size;
}

/** Canvas2D backend. `base` is the view transform already applied to ctx (device px). */
export class CanvasPainter implements Painter {
  readonly kind = "canvas" as const;
  private stack: Mat[] = [];
  private m: Mat;
  private lastFont = "";
  constructor(private ctx: CanvasRenderingContext2D, base: Mat, private dpr = 1) {
    this.m = base;
    ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
  }
  save() {
    this.stack.push(this.m);
    this.ctx.save();
  }
  restore() {
    this.m = this.stack.pop() ?? this.m;
    this.ctx.restore();
  }
  transform(t: Mat) {
    this.m = mulMat(this.m, t);
    this.ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
  }
  /** device px per scene unit */
  scale() {
    return Math.hypot(this.m[0], this.m[1]);
  }
  stroke(p: PathData, s: StrokeStyle) {
    if (!p.ops.length) return;
    const c = this.ctx;
    const sc = this.scale();
    const min = ((s.minPx ?? 0) * this.dpr) / sc;
    c.lineWidth = Math.max(s.width, min);
    c.strokeStyle = s.color;
    c.lineCap = s.cap ?? "butt";
    c.lineJoin = s.join ?? "miter";
    if (s.dash) c.setLineDash(s.dash.map((d) => d * Math.max(1, c.lineWidth)));
    if (s.alpha !== undefined && s.alpha !== 1) c.globalAlpha = s.alpha;
    c.stroke(toPath2D(p));
    if (s.dash) c.setLineDash([]);
    if (s.alpha !== undefined && s.alpha !== 1) c.globalAlpha = 1;
  }
  private static combined = new WeakMap<PathData[], Path2D>();
  strokeMany(paths: PathData[], s: StrokeStyle) {
    if (!paths.length) return;
    let c = CanvasPainter.combined.get(paths);
    if (!c) {
      c = new Path2D();
      for (const p of paths) c.addPath(toPath2D(p));
      CanvasPainter.combined.set(paths, c);
    }
    const ctx = this.ctx;
    const min = ((s.minPx ?? 0) * this.dpr) / this.scale();
    ctx.lineWidth = Math.max(s.width, min);
    ctx.strokeStyle = s.color;
    ctx.lineCap = s.cap ?? "butt";
    ctx.lineJoin = s.join ?? "miter";
    if (s.dash) ctx.setLineDash(s.dash.map((d) => d * Math.max(1, ctx.lineWidth)));
    if (s.alpha !== undefined && s.alpha !== 1) ctx.globalAlpha = s.alpha;
    ctx.stroke(c);
    if (s.dash) ctx.setLineDash([]);
    if (s.alpha !== undefined && s.alpha !== 1) ctx.globalAlpha = 1;
  }
  fill(p: PathData, color: string, alpha?: number) {
    if (!p.ops.length) return;
    const c = this.ctx;
    c.fillStyle = color;
    if (alpha !== undefined && alpha !== 1) c.globalAlpha = alpha;
    c.fill(toPath2D(p));
    if (alpha !== undefined && alpha !== 1) c.globalAlpha = 1;
  }
  text(t: TextDraw) {
    const c = this.ctx;
    const f = fontString(t.size, t.font, t.weight, t.italic);
    if (f !== this.lastFont) {
      c.font = f;
      this.lastFont = f;
    }
    const rotated = !!t.rotation;
    if (rotated) {
      c.save();
      c.translate(t.x, t.y);
      c.rotate((t.rotation! * Math.PI) / 180);
    }
    const x = rotated ? 0 : t.x, y = rotated ? 0 : t.y;
    if (t.alpha !== undefined && t.alpha !== 1) c.globalAlpha = t.alpha;
    c.textAlign = t.align ?? "left";
    c.textBaseline = t.baseline ?? "alphabetic";
    if (t.background) {
      const w = this.measure(t.text, t.size, t.font, t.weight);
      const ax = t.align === "center" ? x - w / 2 : t.align === "right" ? x - w : x;
      const ay = t.baseline === "top" ? y : t.baseline === "middle" ? y - t.size / 2 : y - t.size * 0.8;
      c.fillStyle = t.background;
      c.fillRect(ax - 1, ay - 0.5, w + 2, t.size * 1.15);
    }
    c.fillStyle = t.color;
    c.fillText(t.text, x, y);
    if (t.alpha !== undefined && t.alpha !== 1) c.globalAlpha = 1;
    if (rotated) {
      c.restore();
      this.lastFont = "";
    }
  }
  image(d: ImageDraw) {
    const img = imageFor(d);
    if (!img || d.w <= 0 || d.h <= 0) return;
    this.ctx.drawImage(img, d.x, d.y, d.w, d.h);
  }
  measure(text: string, size: number, font: string, weight?: number) {
    return measureText(text, size, font, weight);
  }
}
