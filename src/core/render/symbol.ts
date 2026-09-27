import type { ElementDef, LineEnd, PinDef, Prim, PrimStyle, Pt, Rect } from "../model";
import { QET_WEIGHTS, qetColor } from "../styles";
import { DASHES, PathBuilder, type PathData, type StrokeStyle } from "./painter";

export const PT = 4 / 3; // QET point sizes → scene px (96 dpi)
export const TERMINAL_STUB = 4;

export type CompiledStroke = { path: PathData; style: StrokeStyle; key: string };
export type CompiledFill = { path: PathData; color: string; alpha: number };
export type CompiledText = {
  x: number;
  y: number;
  text: string;
  size: number; // px
  rotation: number;
  color: string;
  baseline: "alphabetic" | "top";
  align: "left" | "center" | "right";
  dyn?: { from: string; info?: string; width: number; frame: boolean; valign: "top" | "center" | "bottom" };
  bold?: boolean;
  /** the text only repeats a pin number next to that pin (hidden while Volt draws pin numbers) */
  pinDup?: boolean;
};

export type CompiledSymbol = {
  def: ElementDef;
  fills: CompiledFill[];
  strokes: CompiledStroke[];
  texts: CompiledText[];
  pinStubs: PathData;
  pins: PinDef[];
  bbox: Rect; // local frame (width/height/hotspot as saved)
  /** local frame ∪ drawn geometry (pins, strokes) — for hit testing and selection */
  hitBox: Rect;
  /** Coarse LOD outline */
  outline: PathData;
};

function strokeFor(s: PrimStyle): StrokeStyle | null {
  if (s.lineWeight === "none" || s.color === "none") return null;
  const w = QET_WEIGHTS[s.lineWeight] ?? 1;
  return { color: qetColor(s.color), width: w, dash: DASHES[s.lineStyle] ?? null, cap: "square", join: "miter", minPx: 1 };
}

function fillFor(s: PrimStyle): { color: string; alpha: number } | null {
  const f = s.filling;
  if (!f || f === "none") return null;
  if (f === "hor" || f === "ver" || f === "bdiag" || f === "fdiag") return { color: qetColor(s.color), alpha: 0.18 };
  return { color: qetColor(f), alpha: 1 };
}

function addLineEnd(b: PathBuilder, fillB: PathBuilder, tip: Pt, from: Pt, end: LineEnd, len: number) {
  if (end === "none") return;
  const L = len || 1.5;
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const nx = -uy, ny = ux;
  const base = { x: tip.x - ux * L, y: tip.y - uy * L };
  switch (end) {
    case "simple":
      b.M(base.x + nx * L * 0.6, base.y + ny * L * 0.6).L(tip.x, tip.y).L(base.x - nx * L * 0.6, base.y - ny * L * 0.6);
      break;
    case "triangle":
      fillB.M(tip.x, tip.y).L(base.x + nx * L * 0.6, base.y + ny * L * 0.6).L(base.x - nx * L * 0.6, base.y - ny * L * 0.6).Z();
      break;
    case "circle":
      b.E(tip.x - ux * L * 0.5, tip.y - uy * L * 0.5, L * 0.5, L * 0.5);
      break;
    case "diamond": {
      const m = { x: tip.x - ux * L * 0.5, y: tip.y - uy * L * 0.5 };
      b.M(tip.x, tip.y).L(m.x + nx * L * 0.4, m.y + ny * L * 0.4).L(base.x, base.y).L(m.x - nx * L * 0.4, m.y - ny * L * 0.4).Z();
      break;
    }
  }
}

const styleKey = (s: StrokeStyle) => `${s.color}|${s.width}|${s.dash?.join(",") ?? ""}`;
const rad = (d: number) => (d * Math.PI) / 180;

/** Compile a definition into grouped, cacheable drawing data. */
export function compileSymbol(def: ElementDef): CompiledSymbol {
  const strokeGroups = new Map<string, { b: PathBuilder; style: StrokeStyle }>();
  const fillGroups = new Map<string, { b: PathBuilder; color: string; alpha: number }>();
  const texts: CompiledText[] = [];
  const S = (st: StrokeStyle | null) => {
    if (!st) return null;
    const k = styleKey(st);
    let g = strokeGroups.get(k);
    if (!g) strokeGroups.set(k, (g = { b: new PathBuilder(), style: st }));
    return g.b;
  };
  const F = (f: { color: string; alpha: number } | null) => {
    if (!f) return null;
    const k = f.color + "|" + f.alpha;
    let g = fillGroups.get(k);
    if (!g) fillGroups.set(k, (g = { b: new PathBuilder(), ...f }));
    return g.b;
  };

  for (const p of def.prims) compilePrim(p, S, F, texts);
  markPinNumberTexts(texts, def.pins);

  // placeholder box if definition missing
  if (def.placeholder || (!def.prims.length && def.pins.length)) {
    const b = S({ color: "#9ca3af", width: 1, dash: [4, 3], minPx: 1 })!;
    b.R(-def.hotspotX, -def.hotspotY, def.width || 20, def.height || 20);
  }

  const stubs = new PathBuilder();
  for (const pin of def.pins) {
    const v = pin.orient === "n" ? [0, 1] : pin.orient === "s" ? [0, -1] : pin.orient === "e" ? [-1, 0] : [1, 0];
    stubs.M(pin.x, pin.y).L(pin.x + v[0] * TERMINAL_STUB, pin.y + v[1] * TERMINAL_STUB);
  }

  // The saved frame (width/height/hotspot) can be smaller than what is actually drawn — e.g. hand-made
  // elements or files from other editors. Hit testing, snapping and selection use the union of both,
  // so every pin and stroke of the symbol is reachable.
  const bbox = { x: -def.hotspotX, y: -def.hotspotY, w: def.width || 10, h: def.height || 10 };
  const hitBox = geometryBounds(def, bbox);
  return {
    def,
    fills: [...fillGroups.values()].map((g) => ({ path: g.b.build(), color: g.color, alpha: g.alpha })),
    strokes: [...strokeGroups.values()].map((g) => ({ path: g.b.build(), style: g.style, key: styleKey(g.style) })),
    texts,
    pinStubs: stubs.build(),
    pins: def.pins,
    bbox,
    hitBox,
    outline: new PathBuilder().R(bbox.x, bbox.y, bbox.w, bbox.h).build(),
  };
}

function compilePrim(
  p: Prim,
  S: (s: StrokeStyle | null) => PathBuilder | null,
  F: (f: { color: string; alpha: number } | null) => PathBuilder | null,
  texts: CompiledText[],
) {
  switch (p.t) {
    case "line": {
      const b = S(strokeFor(p.style));
      if (!b) return;
      b.M(p.x1, p.y1).L(p.x2, p.y2);
      const fb = F({ color: qetColor(p.style.color), alpha: 1 })!;
      addLineEnd(b, fb, { x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }, p.end1, p.len1);
      addLineEnd(b, fb, { x: p.x2, y: p.y2 }, { x: p.x1, y: p.y1 }, p.end2, p.len2);
      return;
    }
    case "rect": {
      F(fillFor(p.style))?.RR(p.x, p.y, p.w, p.h, p.rx, p.ry);
      S(strokeFor(p.style))?.RR(p.x, p.y, p.w, p.h, p.rx, p.ry);
      return;
    }
    case "ellipse": {
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      F(fillFor(p.style))?.E(cx, cy, p.w / 2, p.h / 2);
      S(strokeFor(p.style))?.E(cx, cy, p.w / 2, p.h / 2);
      return;
    }
    case "arc": {
      // QET: degrees, 0 at 3 o'clock, positive CCW on screen → screen angle = -θ
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      const a0 = -rad(p.start), a1 = -rad(p.start + p.angle);
      S(strokeFor(p.style))?.A(cx, cy, p.w / 2, p.h / 2, a0, a1, p.angle > 0);
      return;
    }
    case "polygon": {
      if (p.pts.length < 2) return;
      if (p.closed) F(fillFor(p.style))?.poly(p.pts, true);
      S(strokeFor(p.style))?.poly(p.pts, p.closed);
      return;
    }
    case "text":
      texts.push({ x: p.x, y: p.y, text: p.text, size: p.size * PT, rotation: p.rotation, color: qetColor(p.color), baseline: "alphabetic", align: "left" });
      return;
    case "dyntext":
      texts.push({
        x: p.x + 4,
        y: p.y + 4,
        text: p.text,
        size: p.size * PT,
        rotation: p.rotation,
        color: qetColor(p.color),
        baseline: "top",
        align: p.halign,
        dyn: { from: p.from, info: p.info, width: p.width, frame: p.frame, valign: p.valign },
      });
      return;
  }
}

/**
 * Many library symbols write their terminal numbers as plain text ("1", "2") beside the pins. Volt
 * draws pin numbers itself (upright, in the project's pin number style), so those texts would show
 * every number twice; they are flagged here and skipped while pin numbers are shown.
 */
function markPinNumberTexts(texts: CompiledText[], pins: PinDef[]) {
  const nums = pins.filter((p) => p.number.trim());
  if (!nums.length) return;
  for (const t of texts) {
    if (t.dyn && t.dyn.from !== "UserText") continue;
    const s = t.text.trim();
    if (!s || s.length > 4) continue;
    // approximate middle of the glyph box (rotation about the anchor)
    const w = s.length * t.size * 0.55, h = t.size * 0.7;
    const r = (t.rotation * Math.PI) / 180;
    const dx = w / 2, dy = t.baseline === "top" ? h / 2 : -h / 2;
    const cx = t.x + dx * Math.cos(r) - dy * Math.sin(r), cy = t.y + dx * Math.sin(r) + dy * Math.cos(r);
    if (nums.some((p) => p.number.trim() === s && Math.hypot(p.x - cx, p.y - cy) <= 16 + t.size)) t.pinDup = true;
  }
}

/** Symbol cache keyed by def object identity (defs are immutable once in a doc snapshot). */
const cache = new WeakMap<ElementDef, CompiledSymbol>();
export function symbolFor(def: ElementDef): CompiledSymbol {
  let c = cache.get(def);
  if (!c) cache.set(def, (c = compileSymbol(def)));
  return c;
}

/** Union of the frame and the drawn geometry (primitives + pin stubs). Texts are left out. */
function geometryBounds(def: ElementDef, frame: Rect): Rect {
  let x0 = frame.x, y0 = frame.y, x1 = frame.x + frame.w, y1 = frame.y + frame.h;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  if (def.placeholder) return frame;
  for (const p of def.prims) {
    switch (p.t) {
      case "line":
        add(p.x1, p.y1);
        add(p.x2, p.y2);
        break;
      case "rect":
      case "ellipse":
      case "arc":
        add(p.x, p.y);
        add(p.x + p.w, p.y + p.h);
        break;
      case "polygon":
        for (const q of p.pts) add(q.x, q.y);
        break;
    }
  }
  for (const pin of def.pins) {
    add(pin.x, pin.y);
    const v = pin.orient === "n" ? [0, 1] : pin.orient === "s" ? [0, -1] : pin.orient === "e" ? [-1, 0] : [1, 0];
    add(pin.x + v[0] * TERMINAL_STUB, pin.y + v[1] * TERMINAL_STUB);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
