import { COMPONENT_INFO } from "../model";
import { layoutRich, type RichLayout } from "../richtext";
import { drawContents, drawCoverSheet } from "./cover";
import { mateLabel } from "../mating";
import type { Doc, ElemInst, ElementDef, FreeText, Junction, Page, PinDef, PlacedText, Pt, Rect, Styles, TextStyle, TitleBlockTemplate, Wire } from "../model";
import { effectiveText, projectStyles } from "../styles";
import { elemMatrix, pointAlong, rotOrient, toScene, transformRect, unionRect } from "../geometry";
import { templateLogos, titleBlockColumnWidths, titleBlockHeight } from "../qet/titleblock";
import { fitContain, LOGO_MIME, logoKey, logoSize } from "../logos";
import { defaultTitleBlock } from "../doc";
import { DASHES, PathBuilder, type Painter, type PathData, type StrokeStyle } from "./painter";
import { PT, symbolFor, type CompiledSymbol } from "./symbol";
import { cableMarks, sectionWeight, wireAnnotation, wireEndLabel, wireInfo, wiringOf } from "../wiring";

/* ------------------------------------------------------------------ */
/* Style cache                                                          */
/* ------------------------------------------------------------------ */

const styleCache = new WeakMap<Doc["styles"], { base: Styles; eff: Styles }>();
export function docStyles(doc: Doc): Styles {
  const c = styleCache.get(doc.styles);
  if (c && c.base === doc.baseStyles) return c.eff;
  const eff = projectStyles(doc.baseStyles, doc.styles);
  styleCache.set(doc.styles, { base: doc.baseStyles, eff });
  return eff;
}

/* ------------------------------------------------------------------ */
/* Page frame                                                           */
/* ------------------------------------------------------------------ */

export function tbTemplate(doc: Doc, page: Page): TitleBlockTemplate {
  return doc.titleBlocks[page.titleBlock.template] ?? doc.titleBlocks.default ?? defaultTitleBlock();
}

export function pageGeometry(doc: Doc, page: Page) {
  const b = page.border;
  const w = b.headerW * (b.showRows ? 1 : 0) + b.cols * b.colW;
  const h = b.headerH * (b.showCols ? 1 : 0) + b.rows * b.rowH;
  const tbH = page.titleBlock.show ? titleBlockHeight(tbTemplate(doc, page)) : 0;
  return { border: { x: 0, y: 0, w, h }, titleBlock: { x: 0, y: h, w, h: tbH }, total: { x: 0, y: 0, w, h: h + tbH } };
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                         */
/* ------------------------------------------------------------------ */

export function textValue(t: PlacedText, e: ElemInst, def: ElementDef | undefined): string {
  if (t.info) return e.info[t.info] ?? def?.info[t.info] ?? "";
  return t.text;
}

export type LaidText = {
  text: string;
  x: number; // anchor (top-left of glyph box, before rotation)
  y: number;
  rotation: number;
  style: TextStyle;
  w: number;
  h: number;
  /** part of the component info block: the block's top-left (scene), used to drag it */
  block?: Pt;
};

const px = (s: TextStyle) => s.size * PT;

/** Keep text readable (no upside-down / top-to-bottom text) by rotating 180° about its box. */
function readable(x: number, y: number, rot: number, w: number, h: number): { x: number; y: number; rot: number } {
  const r = ((rot % 360) + 360) % 360;
  if (r > 45 && r <= 225) {
    const a = (r * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    // P' = P + R(θ)·(w,h)
    return { x: x + c * w - s * h, y: y + s * w + c * h, rot: r + 180 };
  }
  return { x, y, rot: r };
}

/** Lay out every visible text of an element instance in scene coordinates. */
export function layoutElementTexts(e: ElemInst, sym: CompiledSymbol, styles: Styles, measure: Painter["measure"]): LaidText[] {
  const out: LaidText[] = [];
  const def = sym.def;
  const used = new Set<string>();
  const bb = sym.bbox;
  let autoRow = 0;
  let ref: LaidText | null = null;
  const shown = new Set<string>();
  for (const t of e.texts) {
    if (t.uuid) used.add(t.uuid);
    const style = effectiveText(styles, t.role, t.override);
    if (!style.visible) continue;
    const text = textValue(t, e, def);
    if (!text) continue;
    const size = px(style);
    const w = measure(text, size, style.font, style.weight);
    const h = size * style.lineHeight;
    let lx: number, ly: number;
    if (t.x === null || t.y === null) {
      // default anchor: right of the symbol, stacked
      lx = bb.x + bb.w + 4 + style.dx;
      ly = bb.y + autoRow * (h + 1) + style.dy;
      autoRow++;
    } else {
      lx = t.x + 4 + style.dx;
      ly = t.y + 4 + style.dy;
    }
    const alignOff = style.align === "center" ? -w / 2 : style.align === "right" ? -w : 0;
    const p = toScene(e, { x: lx + alignOff, y: ly });
    // a fixed rotation (set on the text) ignores the component's rotation
    const baseRot = t.rotation !== undefined ? t.rotation : e.rot * 90 + (style.rotation || 0);
    // element rotation also rotates the text box origin; keep readable
    const r = readable(p.x, p.y, baseRot, w, h);
    const lt: LaidText = { text, x: r.x, y: r.y, rotation: r.rot, style, w, h };
    out.push(lt);
    if (t.info === "label" && !ref) ref = lt;
    if (t.info) shown.add(t.info);
  }
  // definition dynamic texts are templates: QElectroTech (≥0.7) and Volt instantiate them on the
  // element when placed, so they are only drawn for legacy instances that carry no texts at all.
  const instantiated = e.texts.length > 0;
  const pinNums = e.showPinNumbers ?? styles.text.pinNumber.visible;
  for (const ct of sym.texts) {
    if (!ct.dyn || instantiated || (ct.pinDup && pinNums)) continue;
    const dp = def.prims.find((p) => p.t === "dyntext" && p.x + 4 === ct.x && p.y + 4 === ct.y && p.text === ct.text);
    if (dp && dp.t === "dyntext" && dp.uuid && used.has(dp.uuid)) continue;
    const role = ct.dyn.info === "label" || ct.dyn.info === "formula" ? "componentRef" : ct.dyn.info === "comment" ? "componentName" : "annotation";
    const style = effectiveText(styles, role, { size: ct.size / PT, color: ct.color });
    if (!style.visible) continue;
    const text = ct.dyn.from === "ElementInfo" && ct.dyn.info ? e.info[ct.dyn.info] ?? def.info[ct.dyn.info] ?? "" : ct.text;
    if (!text) continue;
    const size = px(style);
    const w = measure(text, size, style.font, style.weight);
    const h = size * style.lineHeight;
    const p = toScene(e, { x: ct.x, y: ct.y });
    const r = readable(p.x, p.y, e.rot * 90 + ct.rotation, w, h);
    const lt: LaidText = { text, x: r.x, y: r.y, rotation: r.rot, style, w, h };
    out.push(lt);
    if (ct.dyn.info === "label" && !ref) ref = lt;
    if (ct.dyn.info) shown.add(ct.dyn.info);
  }
  layoutComponentInfo(e, def, styles, measure, out, ref, shown, bb, autoRow);
  return out;
}

/**
 * Component information block (name, rating, part number, manufacturer) like the description /
 * rating / catalog attributes of CAE tools. Each line has its own global text style (font, size,
 * color, weight, visibility, line spacing, alignment) and can be shown or hidden per component.
 * The block sits under the reference, or right / left / below the symbol, aligned left, centre or right.
 */
function layoutComponentInfo(e: ElemInst, def: ElementDef, styles: Styles, measure: Painter["measure"], out: LaidText[], ref: LaidText | null, shown: Set<string>, bb: Rect, autoRow: number) {
  const flags = { ...(styles.graphics.componentInfo ?? {}), ...(e.showInfo ?? {}) };
  const layout = { ...(styles.graphics.componentInfoLayout ?? {}), ...(e.infoLayout ?? {}) };
  type Seg = { text: string; style: TextStyle; size: number; w: number; h: number };
  const seg = (text: string, style: TextStyle): Seg => {
    const size = px(style);
    return { text, style, size, w: measure(text, size, style.font, style.weight), h: size * style.lineHeight };
  };
  const value = (k: (typeof COMPONENT_INFO)[number]) => {
    if (shown.has(k.key) || !flags[k.key]) return null;
    const text = (e.info[k.key] ?? def.info[k.key] ?? "").trim();
    const style = styles.text[k.role];
    return text && style?.visible ? seg(text, style) : null;
  };
  const [nameK, ratingK, partK, mfrK] = COMPONENT_INFO;
  // rows: name, rating, then "manufacturer · part number" on one line (each part in its own style)
  const rows: Seg[][] = [];
  for (const k of [nameK, ratingK]) {
    const v = value(k);
    if (v) rows.push([v]);
  }
  const mfr = value(mfrK), part = value(partK);
  if (mfr && part) rows.push([mfr, seg(" · ", part.style), part]);
  else if (mfr || part) rows.push([(mfr ?? part)!]);
  if (!rows.length) return;
  const rowW = (r: Seg[]) => r.reduce((t, x) => t + x.w, 0);
  const rowSize = (r: Seg[]) => Math.max(...r.map((x) => x.size));
  const W = Math.max(...rows.map(rowW));
  const alignOf = (r: Seg[]) => layout.align ?? r[0].style.align ?? "left";
  // rows stacked baseline to baseline: each row's own spacing (size × line spacing) above its baseline
  const ASC = 0.8;
  const baselines: number[] = [];
  rows.forEach((r, i) => baselines.push(i === 0 ? rowSize(r) * ASC : baselines[i - 1] + rowSize(r) * Math.max(...r.map((x) => x.style.lineHeight))));
  const H = baselines[baselines.length - 1] + rowSize(rows[rows.length - 1]) * (1 - ASC);
  const emit = (ox: number, oy: number, rot: number, nx: number, ny: number, dx: number, dy: number) => {
    const block = { x: ox, y: oy };
    rows.forEach((r, i) => {
      const a = alignOf(r);
      let along = a === "center" ? (W - rowW(r)) / 2 : a === "right" ? W - rowW(r) : 0;
      for (const sgm of r) {
        const down = baselines[i] - sgm.size * ASC + sgm.style.dy;
        const at = along + sgm.style.dx;
        out.push({ text: sgm.text, x: ox + dx * at + nx * down, y: oy + dy * at + ny * down, rotation: rot, style: sgm.style, w: sgm.w, h: sgm.h, block });
        along += sgm.w;
      }
    });
  };

  const body = transformRect(e, symbolFor(def).bbox);
  const at = layout.at ?? "auto";
  if (at === "free" && layout.pos) {
    const p = toScene(e, layout.pos);
    emit(p.x, p.y, 0, 0, 1, 1, 0);
    return;
  }
  if (at !== "auto" || !ref || ref.rotation === 0) {
    const gap = 3;
    let x0: number, y0: number;
    const refBox = ref ? textBounds(ref) : null;
    if (at === "right") (x0 = body.x + body.w + gap), (y0 = body.y);
    else if (at === "left") (x0 = body.x - gap - W), (y0 = body.y);
    else if (at === "below") (x0 = body.x + body.w / 2 - W / 2), (y0 = body.y + body.h + gap);
    else if (ref) {
      // auto: under the reference; beside the symbol if that would run across it
      (x0 = ref.x), (y0 = ref.y + ref.h + 0.5);
      const hit = x0 < body.x + body.w && x0 + W > body.x && y0 < body.y + body.h && y0 + H > body.y;
      if (hit) (x0 = Math.max(ref.x, body.x + body.w + gap)), (y0 = ref.y + ref.h + 0.5);
    } else {
      const p = toScene(e, { x: bb.x + bb.w + 4, y: bb.y + autoRow * 10 });
      (x0 = p.x), (y0 = p.y);
    }
    // never on top of the reference
    if (refBox && x0 < refBox.x + refBox.w && x0 + W > refBox.x && y0 < refBox.y + refBox.h && y0 + H > refBox.y) y0 = refBox.y + refBox.h + 0.5;
    emit(x0, y0, 0, 0, 1, 1, 0);
    return;
  }
  // rotated reference: continue in its own direction, one row further "down" in text space
  const r = (ref.rotation * Math.PI) / 180;
  emit(ref.x - Math.sin(r) * (ref.h + 0.5), ref.y + Math.cos(r) * (ref.h + 0.5), ref.rotation, -Math.sin(r), Math.cos(r), Math.cos(r), Math.sin(r));
}

/** Pin number / name placement in scene coordinates (always readable). */
export function layoutPinTexts(e: ElemInst, pin: PinDef, styles: Styles, showNum: boolean, showName: boolean, measure: Painter["measure"]): LaidText[] {
  const out: LaidText[] = [];
  const p = toScene(e, pin);
  const o = rotOrient(pin.orient, e.rot, e.mirror);
  if (showNum && pin.number) {
    const st = styles.text.pinNumber;
    const size = px(st);
    const w = measure(pin.number, size, st.font, st.weight);
    const h = size * st.lineHeight;
    // beside the stub, 1.5 units away, centered on the stub
    let x: number, y: number;
    if (o === "n" || o === "s") {
      x = p.x + 1.5 + st.dx;
      y = (o === "n" ? p.y + 0.5 : p.y - h - 0.5) + st.dy;
    } else {
      x = (o === "w" ? p.x + 0.5 : p.x - w - 0.5) + st.dx;
      y = p.y - h - 0.5 + st.dy;
    }
    out.push({ text: pin.number, x, y, rotation: 0, style: st, w, h });
  }
  if (showName && pin.name && pin.name !== pin.number) {
    const st = styles.text.pinName;
    const size = px(st);
    const w = measure(pin.name, size, st.font, st.weight);
    const h = size * st.lineHeight;
    const inset = 6;
    let x: number, y: number;
    if (o === "n") (x = p.x - w / 2), (y = p.y + inset);
    else if (o === "s") (x = p.x - w / 2), (y = p.y - inset - h);
    else if (o === "w") (x = p.x + inset), (y = p.y - h / 2);
    else (x = p.x - inset - w), (y = p.y - h / 2);
    out.push({ text: pin.name, x: x + st.dx, y: y + st.dy, rotation: 0, style: st, w, h });
  }
  return out;
}

/** layout of a free text in its own box coordinates (cached per text object and style) */
const freeLayouts = new WeakMap<FreeText, { key: string; l: RichLayout }>();
export function freeTextLayout(t: FreeText, styles: Styles, measure: Painter["measure"]): { l: RichLayout; st: TextStyle } {
  const st = effectiveText(styles, t.role, t.override);
  const key = JSON.stringify(st) + (t.rich ? JSON.stringify(t.rich) : "");
  const hit = freeLayouts.get(t);
  if (hit && hit.key === key) return { l: hit.l, st };
  let l: RichLayout;
  if (t.rich) l = layoutRich(t.text, st, t.rich, measure);
  else {
    // plain text: one line per text line, as typed
    const size = st.size * PT;
    const lines = t.text.split("\n");
    const items = lines.map((line, i) => ({ text: line, x: 4, y: 4 + i * size * st.lineHeight, size, weight: st.weight, italic: st.italic }));
    const w = Math.max(10, ...lines.map((line) => measure(line, size, st.font, st.weight)));
    l = { w: w + 8, h: lines.length * size * st.lineHeight + 8, items, rules: [], pad: 4 };
  }
  freeLayouts.set(t, { key, l });
  return { l, st };
}

/** scene bounds of a free text (its box, rotated) */
export function freeTextBounds(t: FreeText, styles: Styles, measure: Painter["measure"]): Rect {
  const { l, st } = freeTextLayout(t, styles, measure);
  const ox = t.x + st.dx, oy = t.y + st.dy;
  return textBounds({ text: "", x: ox, y: oy, rotation: st.rotation || 0, style: st, w: l.w, h: l.h });
}

export function drawFreeText(pt: Painter, t: FreeText, styles: Styles, measure: Painter["measure"], alpha?: number, tint?: string) {
  const { l, st } = freeTextLayout(t, styles, measure);
  if (!st.visible) return;
  const a = ((st.rotation || 0) * Math.PI) / 180;
  pt.save();
  pt.transform([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), t.x + st.dx, t.y + st.dy]);
  const r = t.rich;
  if (r?.background) pt.fill(new PathBuilder().R(0, 0, l.w, l.h).build(), r.background, alpha);
  if (r?.border && r.border.width > 0) pt.stroke(new PathBuilder().R(0, 0, l.w, l.h).build(), { color: tint ?? r.border.color, width: r.border.width, alpha });
  if (l.rules.length) {
    const b = new PathBuilder();
    for (const ru of l.rules) b.M(ru.x1, ru.y).L(ru.x2, ru.y);
    pt.stroke(b.build(), { color: tint ?? st.color, width: 0.75, alpha });
  }
  for (const it of l.items)
    pt.text({ text: it.text, x: it.x, y: it.y, size: it.size, font: st.font, weight: it.weight, italic: it.italic, color: tint ?? st.color, baseline: "top", background: r ? null : st.background, alpha });
  pt.restore();
}

export function drawLaidText(pt: Painter, t: LaidText, alpha?: number, colorOverride?: string) {
  pt.text({
    text: t.text,
    x: t.x,
    y: t.y,
    size: px(t.style),
    font: t.style.font,
    weight: t.style.weight,
    italic: t.style.italic,
    color: colorOverride ?? t.style.color,
    baseline: "top",
    rotation: t.rotation,
    background: t.style.background,
    alpha,
  });
}

/* ------------------------------------------------------------------ */
/* Bounds (for spatial index / fit)                                     */
/* ------------------------------------------------------------------ */

export function elementBounds(e: ElemInst, def: ElementDef): Rect {
  const sym = symbolFor(def);
  return transformRect(e, sym.hitBox);
}

export function textBounds(t: LaidText): Rect {
  const a = (t.rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const pts = [
    { x: 0, y: 0 },
    { x: t.w, y: 0 },
    { x: t.w, y: t.h },
    { x: 0, y: t.h },
  ].map((p) => ({ x: t.x + p.x * c - p.y * s, y: t.y + p.x * s + p.y * c }));
  let r: Rect | null = null;
  for (const p of pts) r = unionRect(r, { x: p.x, y: p.y, w: 0, h: 0 });
  return r!;
}

/* ------------------------------------------------------------------ */
/* Connectivity helpers for rendering                                   */
/* ------------------------------------------------------------------ */

export type Degrees = { pin: Map<string, number>; junction: Map<string, number> };
export function endDegrees(page: Page): Degrees {
  const pin = new Map<string, number>();
  const junction = new Map<string, number>();
  const inc = (end: Wire["a"]) => {
    if (end.k === "pin") pin.set(end.el + "/" + end.pin, (pin.get(end.el + "/" + end.pin) ?? 0) + 1);
    else if (end.k === "junction") junction.set(end.j, (junction.get(end.j) ?? 0) + 1);
  };
  for (const w of page.wires) {
    inc(w.a);
    inc(w.b);
  }
  return { pin, junction };
}

/* ------------------------------------------------------------------ */
/* Drawing                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Render caches (keyed by immutable object identity)                   */
/* ------------------------------------------------------------------ */

const wirePathCache = new WeakMap<Wire, PathData>();
export function wirePath(w: Wire): PathData {
  let p = wirePathCache.get(w);
  if (!p) wirePathCache.set(w, (p = new PathBuilder().poly(w.pts).build()));
  return p;
}
type WireGroup = { style: StrokeStyle; paths: PathData[]; dim: boolean };
type WireLookDoc = Pick<Doc, "wiring" | "cables">;
const groupCache = new WeakMap<Wire[], { styles: Styles; wiring: unknown; cables: unknown; groups: WireGroup[] }>();
function wireGroups(styles: Styles, wires: Wire[], doc: WireLookDoc, tint?: Map<string, string>, dim?: Set<string>): WireGroup[] {
  const cacheable = !tint && !dim;
  if (cacheable) {
    const c = groupCache.get(wires);
    if (c && c.styles === styles && c.wiring === doc.wiring && c.cables === doc.cables) return c.groups;
  }
  const m = new Map<string, WireGroup>();
  const add = (st: StrokeStyle, d: boolean, path: PathData) => {
    const k = `${st.color}|${st.width}|${st.dash?.join(",") ?? ""}|${d}`;
    let g = m.get(k);
    if (!g) m.set(k, (g = { style: st, paths: [], dim: d }));
    g.paths.push(path);
  };
  const stripes: [StrokeStyle, boolean, PathData][] = [];
  for (const w of wires) {
    if (w.pts.length < 2) continue;
    const t = tint?.get(w.id);
    const st = wireStroke(styles, w, t, doc);
    const d = !!dim?.has(w.id);
    add(st, d, wirePath(w));
    // two-colour insulation (green-yellow …): second colour as stripes on top
    const second = !t && wireSecondColor(doc, w);
    if (second) stripes.push([{ ...st, color: second, dash: [st.width * 3, st.width * 3], cap: "butt" }, d, wirePath(w)]);
  }
  for (const [st, d, p] of stripes) add(st, d, p);
  const groups = [...m.values()];
  if (cacheable) groupCache.set(wires, { styles, wiring: doc.wiring, cables: doc.cables, groups });
  return groups;
}
function wireSecondColor(doc: WireLookDoc, w: Wire): string | null {
  return insulationHex(doc, w)?.hex2 ?? null;
}
/**
 * Colour a wire is drawn in from its conductor data: an explicit color (on the wire or its cable
 * core) always; the standard color of its function only with "draw in standard colors" on.
 */
function insulationHex(doc: WireLookDoc, w: Wire): { hex: string; hex2?: string } | null {
  if (!w.insulation && !w.core && !(doc.wiring?.colorize && w.fn)) return null;
  const i = wireInfo(doc, w);
  if (!i.look) return null;
  if (i.colorSource === "standard" && !doc.wiring?.colorize) return null;
  return { hex: i.look.hex, hex2: i.look.hex2 };
}
const degCache = new WeakMap<Wire[], Degrees>();
export function cachedDegrees(page: Page): Degrees {
  let d = degCache.get(page.wires);
  if (!d) degCache.set(page.wires, (d = endDegrees(page)));
  return d;
}
const elIndexCache = new WeakMap<ElemInst[], Map<string, ElemInst>>();
export function elementIndex(page: Page): Map<string, ElemInst> {
  let m = elIndexCache.get(page.elements);
  if (!m) elIndexCache.set(page.elements, (m = new Map(page.elements.map((e) => [e.id, e]))));
  return m;
}
const textLayoutCache = new WeakMap<ElemInst, { styles: Styles; def: ElementDef; laid: LaidText[]; key: string }>();
/** `key` identifies the measuring backend (text metrics differ between canvas and PDF fonts). */
export function cachedElementTexts(e: ElemInst, sym: CompiledSymbol, styles: Styles, measure: Painter["measure"], key = "canvas"): LaidText[] {
  const c = textLayoutCache.get(e);
  if (c && c.styles === styles && c.def === sym.def && c.key === key) return c.laid;
  const laid = layoutElementTexts(e, sym, styles, measure);
  textLayoutCache.set(e, { styles, def: sym.def, laid, key });
  return laid;
}

export type DrawOpts = {
  doc: Doc;
  page: Page;
  styles?: Styles;
  /** subsets to draw (culling); default = all */
  elements?: ElemInst[];
  wires?: Wire[];
  junctions?: Junction[];
  texts?: FreeText[];
  /** px per scene unit for LOD decisions (canvas); exports pass a large number */
  lod?: number;
  editor?: { pins: boolean; dangling: boolean; pinHover?: string | null };
  decor?: boolean; // border + title block
  tint?: Map<string, string>; // id -> color (diff / highlight)
  dim?: Set<string>;
  alpha?: number;
  pageIndex?: number;
  pageCount?: number;
  version?: string;
  extraFields?: Record<string, string>;
};

export function wireStroke(styles: Styles, w: Wire, tint?: string, doc?: WireLookDoc): StrokeStyle {
  const base = w.bus ? styles.graphics.bus : styles.graphics.wire;
  const o = w.override ?? {};
  const ws = doc?.wiring;
  const insul = doc ? insulationHex(doc, w) : null;
  const weight = ws?.weightBySection && o.width === undefined ? sectionWeight(wireInfo(doc!, w).section) : 1;
  return {
    // a conductor color wins over the appearance color; appearance applies when none is set
    color: tint ?? insul?.hex ?? o.color ?? base.color,
    width: (o.width ?? base.width) * weight,
    dash: DASHES[o.dash ?? base.dash] ?? null,
    cap: "round",
    join: "round",
    minPx: 1,
  };
}

export function drawPage(pt: Painter, o: DrawOpts) {
  const { doc, page } = o;
  const styles = o.styles ?? docStyles(doc);
  const lod = o.lod ?? 100;
  const measure = pt.measure.bind(pt);

  if (o.decor !== false) drawDecor(pt, o, styles);
  // generated sheets
  if (page.kind === "cover") drawCoverSheet(pt, doc, page, styles, titleVars(o), measure);
  else if (page.kind === "contents") drawContents(pt, doc, page, styles, measure);

  pt.begin?.("shapes");
  for (const s of page.shapes) {
    const b = new PathBuilder();
    if (s.kind === "ellipse" && s.pts.length >= 2) {
      const [a, c] = s.pts;
      b.E((a.x + c.x) / 2, (a.y + c.y) / 2, Math.abs(c.x - a.x) / 2, Math.abs(c.y - a.y) / 2);
    } else if (s.kind === "rect" && s.pts.length >= 2) {
      const [a, c] = s.pts;
      b.R(Math.min(a.x, c.x), Math.min(a.y, c.y), Math.abs(c.x - a.x), Math.abs(c.y - a.y));
    } else b.poly(s.pts, s.kind === "polygon" && s.closed !== false);
    const path = b.build();
    if (s.fill) pt.fill(path, s.fill);
    if (s.image && s.pts.length >= 2 && pt.image) {
      const [a, c] = s.pts;
      const box = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
      const size = logoSize(s.image);
      if (size) pt.image({ key: logoKey(s.image), mime: LOGO_MIME[s.image.type], data: s.image.data, ...fitContain(size, box, 0) });
    }
    if (!s.image || s.width > 0) pt.stroke(path, { color: s.color, width: s.width, dash: DASHES[s.dash], minPx: 1 });
  }
  pt.end?.();

  // wires — cached paths, batched per stroke style (one native stroke per style on canvas)
  const wires = o.wires ?? page.wires;
  pt.begin?.("wires");
  const groups = wireGroups(styles, wires, doc, o.tint, o.dim);
  for (const g of groups) {
    const st = { ...g.style, alpha: g.dim ? 0.25 : o.alpha };
    if (pt.strokeMany) pt.strokeMany(g.paths, st);
    else for (const p of g.paths) pt.stroke(p, st);
  }
  // wire numbers, end markers and conductor color / cross-section
  if (lod > 0.35) drawWireTexts(pt, doc, page, wires, styles, measure, o, lod);
  pt.end?.();

  // cables: a line crossing the bundle, labelled with tag and type; dashed ellipse when shielded
  if (lod > 0.25) {
    const cst = styles.text.cableLabel;
    const size = cst.size * PT;
    for (const m of cableMarks(doc, page)) {
      if (o.wires && !m.wires.some((id) => o.wires!.some((w) => w.id === id))) continue;
      const tint = o.tint?.get(m.wires[0]);
      pt.stroke(new PathBuilder().M(m.a.x, m.a.y).L(m.b.x, m.b.y).build(), { color: tint ?? cst.color, width: 1, cap: "round", minPx: 1, alpha: o.alpha });
      if (m.shield) {
        const cx = (m.a.x + m.b.x) / 2, cy = (m.a.y + m.b.y) / 2;
        const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) / 2;
        const rx = m.horizontal ? 5 : len - 2, ry = m.horizontal ? len - 2 : 5;
        pt.stroke(new PathBuilder().E(cx, cy, rx, ry).build(), { color: tint ?? cst.color, width: 0.8, dash: [2, 1.5], minPx: 1, alpha: o.alpha });
      }
      if (cst.visible) {
        const tw = measure(m.label, size, cst.font, cst.weight);
        const h = size * cst.lineHeight;
        if (m.horizontal) drawLaidText(pt, { text: m.label, x: m.a.x - tw / 2, y: m.a.y - h - 1, rotation: 0, style: cst, w: tw, h }, o.alpha, tint);
        else drawLaidText(pt, { text: m.label, x: m.a.x - tw - 2, y: m.a.y - h / 2 - 3, rotation: 0, style: cst, w: tw, h }, o.alpha, tint);
      }
    }
  }

  // junction dots
  const deg = cachedDegrees(page);
  const jr = styles.graphics.wire.junctionRadius;
  const dots = new PathBuilder();
  for (const j of o.junctions ?? page.junctions) {
    if ((deg.junction.get(j.id) ?? 0) >= 3) dots.E(j.x, j.y, jr, jr);
  }
  const elems = o.elements ?? page.elements;
  const byId = elementIndex(page);
  for (const [k, n] of deg.pin) {
    if (n < 3) continue;
    const [elId, pinId] = k.split("/");
    const e = byId.get(elId);
    const def = e && doc.defs[e.defId];
    const pin = def?.pins.find((p) => p.id === pinId);
    if (e && pin) {
      const p = toScene(e, pin);
      dots.E(p.x, p.y, jr, jr);
    }
  }
  pt.fill(dots.build(), styles.graphics.wire.junctionColor, o.alpha);

  // elements
  pt.begin?.("elements");
  for (const e of elems) {
    if (e.hidden) continue;
    const def = doc.defs[e.defId];
    if (!def) continue;
    drawElement(pt, e, def, styles, {
      lod,
      tint: o.tint?.get(e.id),
      alpha: o.dim?.has(e.id) ? 0.25 : o.alpha,
      pins: !!o.editor?.pins,
      measure,
      degrees: deg,
    });
  }
  // mated connectors: "⇄ counterpart" under the symbol (with its sheet when elsewhere)
  if (lod > 0.35)
    for (const e of page.elements) {
      if (!e.mate || e.hidden) continue;
      const def = doc.defs[e.defId];
      const label = def && mateLabel(doc, e, page);
      if (!def || !label) continue;
      const b = elementBounds(e, def);
      const st = styles.text.componentName;
      pt.text({ text: `${e.mate.gender === "male" ? "▸" : "◂"} ${label}`, x: b.x, y: b.y + b.h + 2, size: st.size * PT * 0.9, font: st.font, italic: true, color: o.tint?.get(e.id) ?? "#6b7280", baseline: "top", alpha: o.alpha });
    }
  pt.end?.();

  // free texts
  if (lod > 0.25) {
    pt.begin?.("texts");
    for (const t of o.texts ?? page.texts) drawFreeText(pt, t, styles, measure, o.alpha, o.tint?.get(t.id));
    pt.end?.();
  }

  // dangling ends (editor only)
  if (o.editor?.dangling) {
    const b = new PathBuilder();
    for (const w of wires) {
      if (w.a.k === "free") b.E(w.pts[0].x, w.pts[0].y, 2.5, 2.5);
      if (w.b.k === "free") {
        const p = w.pts[w.pts.length - 1];
        b.E(p.x, p.y, 2.5, 2.5);
      }
    }
    pt.stroke(b.build(), { color: "#ef4444", width: 1, minPx: 1.25 });
  }
}

export function drawElement(
  pt: Painter,
  e: ElemInst,
  def: ElementDef,
  styles: Styles,
  o: { lod: number; tint?: string; alpha?: number; pins?: boolean; measure: Painter["measure"]; degrees?: Degrees; textOnly?: boolean; measureKey?: string },
) {
  const sym = symbolFor(def);
  const outline = styles.graphics.outline;
  const oc = e.outlineOverride?.color ?? o.tint ?? outline.color ?? undefined;
  const ws = e.outlineOverride?.width ?? outline.widthScale;
  pt.save();
  pt.transform(elemMatrix(e));
  const screenSize = Math.max(sym.bbox.w, sym.bbox.h) * o.lod;
  if (screenSize < 3) {
    pt.fill(sym.outline, o.tint ?? "#9ca3af", 0.6);
    pt.restore();
    return;
  }
  for (const f of sym.fills) pt.fill(f.path, o.tint && f.alpha === 1 && f.color !== "#ffffff" ? o.tint : f.color, (o.alpha ?? 1) * f.alpha);
  for (const s of sym.strokes) pt.stroke(s.path, { ...s.style, color: oc ?? s.style.color, width: s.style.width * ws, alpha: o.alpha });
  pt.stroke(sym.pinStubs, { color: oc ?? "#000000", width: 1, minPx: 1, alpha: o.alpha, cap: "butt" });
  // static texts (definition)
  const showNum = e.showPinNumbers ?? styles.text.pinNumber.visible;
  const showName = e.showPinNames ?? styles.text.pinName.visible;
  if (o.lod > 0.3) {
    for (const t of sym.texts) {
      if (t.dyn || (t.pinDup && showNum)) continue;
      pt.text({ text: t.text, x: t.x, y: t.y, size: t.size, font: styles.text.componentName.font, color: o.tint ?? t.color, baseline: t.baseline, rotation: t.rotation, alpha: o.alpha });
    }
  }
  pt.restore();

  if (o.lod > 0.3) {
    for (const lt of cachedElementTexts(e, sym, styles, o.measure, o.measureKey ?? pt.kind)) drawLaidText(pt, lt, o.alpha, o.tint);
    if ((showNum || showName) && o.lod > 0.6) {
      for (const pin of def.pins) for (const lt of layoutPinTexts(e, pin, styles, showNum, showName, o.measure)) drawLaidText(pt, lt, o.alpha, o.tint);
    }
  }

  if (o.pins && o.lod > 0.5) {
    const pc = styles.graphics.pin;
    if (pc.showPoint) {
      const b = new PathBuilder();
      const r = pc.size / Math.max(1, o.lod) + 0.6;
      for (const pin of def.pins) {
        const key = e.id + "/" + pin.id;
        if ((o.degrees?.pin.get(key) ?? 0) > 0) continue;
        const p = toScene(e, pin);
        b.E(p.x, p.y, r, r);
      }
      pt.stroke(b.build(), { color: pc.color, width: 0.8, minPx: 1 });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Border & title block                                                 */
/* ------------------------------------------------------------------ */

export function titleVars(o: DrawOpts): Record<string, string> {
  const { doc, page } = o;
  const idx = o.pageIndex ?? [...doc.pages].sort((a, b) => a.order - b.order).findIndex((p) => p.id === page.id);
  const total = o.pageCount ?? doc.pages.length;
  const f = page.titleBlock.fields;
  const vars: Record<string, string> = {
    ...doc.meta.props,
    projecttitle: doc.meta.title,
    ...f,
    title: f.title || page.title,
    id: String(idx + 1),
    total: String(total),
    autonum: String(idx + 1),
    version: o.version ?? f.version ?? "",
    ...(o.extraFields ?? {}),
  };
  for (const [k, v] of Object.entries(f)) if (k.startsWith("custom:")) vars[k.slice(7)] = v;
  // QElectroTech writes date="null" for "no date"
  for (const k of Object.keys(vars)) if (vars[k] === "null") vars[k] = "";
  // QElectroTech title block variables (folio-id, folio-total, previous/next folio, saved*)
  vars["folio-id"] = vars.id;
  vars["folio-total"] = vars.total;
  vars["previous-folio-num"] = idx > 0 ? String(idx) : "";
  vars["next-folio-num"] = idx + 1 < total ? String(idx + 2) : "";
  vars.projecttitle = doc.meta.title;
  vars.projectfilename = vars.projectfilename ?? doc.qet?.filename ?? "";
  vars.folio = subst(f.folio || "%id/%total", vars);
  return vars;
}

export function subst(s: string, vars: Record<string, string>) {
  return s.replace(/%\{([\w-]+)\}|%(\w+)/g, (_, a, b) => vars[a ?? b] ?? "");
}

function drawDecor(pt: Painter, o: DrawOpts, styles: Styles) {
  const { doc, page } = o;
  const g = pageGeometry(doc, page);
  const bs = styles.graphics.border;
  const b = page.border;
  if (b.show) {
    pt.begin?.("border");
    const stroke: StrokeStyle = { color: bs.color, width: bs.width, dash: DASHES[bs.dash], minPx: 1 };
    const path = new PathBuilder().R(g.border.x, g.border.y, g.border.w, g.border.h);
    const hx = b.showRows ? b.headerW : 0;
    const hy = b.showCols ? b.headerH : 0;
    const hdr = new PathBuilder();
    if (b.showCols) hdr.R(hx, 0, b.cols * b.colW, hy);
    if (b.showRows) hdr.R(0, hy, hx, b.rows * b.rowH);
    pt.fill(hdr.build(), bs.headerColor);
    if (b.showCols) {
      path.M(hx, hy).L(g.border.w, hy);
      for (let i = 1; i < b.cols; i++) path.M(hx + i * b.colW, 0).L(hx + i * b.colW, hy);
    }
    if (b.showRows) {
      path.M(hx, hy).L(hx, g.border.h);
      for (let i = 1; i < b.rows; i++) path.M(0, hy + i * b.rowH).L(hx, hy + i * b.rowH);
    }
    pt.stroke(path.build(), stroke);
    if ((o.lod ?? 100) > 0.2) {
      const size = bs.size * PT;
      for (let i = 0; i < b.cols && b.showCols; i++)
        pt.text({ text: String(i + 1), x: hx + i * b.colW + b.colW / 2, y: hy / 2, size, font: bs.font, color: bs.color, align: "center", baseline: "middle" });
      for (let i = 0; i < b.rows && b.showRows; i++)
        pt.text({ text: String.fromCharCode(65 + (i % 26)), x: hx / 2, y: hy + i * b.rowH + b.rowH / 2, size, font: bs.font, color: bs.color, align: "center", baseline: "middle" });
    }
    pt.end?.();
  }
  if (page.titleBlock.show && g.titleBlock.h > 0) drawTitleBlock(pt, o, styles, g.titleBlock);
}

export function drawTitleBlock(pt: Painter, o: DrawOpts, styles: Styles, r: Rect) {
  const tpl = tbTemplate(o.doc, o.page);
  const ts = styles.graphics.titleBlock;
  const fieldStyle = styles.text.titleBlockField;
  const vars = titleVars(o);
  const colW = titleBlockColumnWidths(tpl, r.w);
  const colX = [r.x];
  for (const w of colW) colX.push(colX[colX.length - 1] + w);
  const rowY = [r.y];
  for (const h of tpl.rows) rowY.push(rowY[rowY.length - 1] + h);
  pt.begin?.("titleblock");
  const grid = new PathBuilder().R(r.x, r.y, r.w, r.h);
  const covered = new Set<string>();
  const lod = o.lod ?? 100;
  for (const c of tpl.cells) {
    if (c.row >= tpl.rows.length || c.col >= colW.length) continue;
    const r2 = Math.min(tpl.rows.length, c.row + c.rowspan + 1);
    const c2 = Math.min(colW.length, c.col + c.colspan + 1);
    for (let i = c.row; i < r2; i++) for (let j = c.col; j < c2; j++) covered.add(i + ":" + j);
    const x = colX[c.col], y = rowY[c.row], w = colX[c2] - x, h = rowY[r2] - y;
    grid.R(x, y, w, h);
    if (c.type === "logo") {
      const logo = c.value ? templateLogos(tpl)[c.value] : undefined;
      const size = logo && pt.image ? logoSize(logo) : null;
      if (logo && size) pt.image!({ key: logoKey(logo), mime: LOGO_MIME[logo.type], data: logo.data, ...fitContain(size, { x, y, w, h }, 2) });
      continue;
    }
    if (c.type !== "field" || lod < 0.25) continue;
    const size = (c.size ?? fieldStyle.size) * PT;
    const label = c.showLabel && c.label ? c.label : "";
    const value = subst(c.value ?? "", vars);
    const small = size * 0.8;
    if (label) pt.text({ text: label, x: x + 3, y: y + 2, size: small, font: ts.font, color: "#6b7280", baseline: "top" });
    if (value) {
      const align = c.align ?? "left";
      const tx = align === "center" ? x + w / 2 : align === "right" ? x + w - 3 : x + 3;
      const ty = label ? y + 2 + small + (h - small - 2) / 2 : y + h / 2;
      pt.text({ text: value, x: tx, y: ty, size, font: ts.font, weight: c.name === "title" ? 600 : fieldStyle.weight, color: fieldStyle.color, align, baseline: "middle" });
    }
  }
  for (let i = 0; i < tpl.rows.length; i++)
    for (let j = 0; j < colW.length; j++) if (!covered.has(i + ":" + j)) grid.R(colX[j], rowY[i], colW[j], tpl.rows[i]);
  pt.stroke(grid.build(), { color: ts.color, width: ts.width, dash: DASHES[ts.dash], minPx: 1 });
  pt.end?.();
}

/** Content bounds of a page (elements, wires, texts) — falls back to the frame. */
export function contentBounds(doc: Doc, page: Page, includeFrame = true): Rect {
  let r: Rect | null = includeFrame ? pageGeometry(doc, page).total : null;
  for (const e of page.elements) {
    const d = doc.defs[e.defId];
    if (d) r = unionRect(r, elementBounds(e, d));
  }
  for (const w of page.wires) for (const p of w.pts) r = unionRect(r, { x: p.x, y: p.y, w: 0, h: 0 });
  for (const t of page.texts) r = unionRect(r, { x: t.x, y: t.y, w: 40, h: 12 });
  for (const s of page.shapes) for (const p of s.pts) r = unionRect(r, { x: p.x, y: p.y, w: 0, h: 0 });
  return r ?? { x: 0, y: 0, w: 800, h: 600 };
}

export function pinScene(e: ElemInst, pin: PinDef): Pt {
  return toScene(e, pin);
}

/** Point on a wire for its conductor annotation: the longest segment the text fits on, at fraction f. */
function annotationAnchor(w: Wire, textW: number, f: number): { p: Pt; horizontal: boolean } {
  let best: { i: number; len: number } | null = null, longest: { i: number; len: number } | null = null;
  for (let i = 0; i < w.pts.length - 1; i++) {
    const a = w.pts[i], b = w.pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!longest || len > longest.len) longest = { i, len };
    if (len >= textW + 8 && (!best || len > best.len)) best = { i, len };
  }
  const s = best ?? longest!;
  const a = w.pts[s.i], b = w.pts[s.i + 1];
  // keep the text clear of the segment ends (pins, corners)
  const margin = Math.min(0.45, (textW / 2 + 4) / Math.max(1, s.len));
  const t = Math.min(1 - margin, Math.max(margin, f));
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, horizontal: Math.abs(b.y - a.y) <= Math.abs(b.x - a.x) };
}

/**
 * Texts of each wire, laid out like common CAE practice:
 * - wire number above a horizontal run (left of a vertical one), in the middle and/or at both ends;
 * - conductor color + cross-section on the other side of the wire at the same spot, with a tick;
 * - end markers (manual names, or the number and the far-end address "X1:8").
 * Texts never pile up on short wires: end markers go first, the second one moves to the other
 * side when needed, a middle number repeated at the ends is dropped, and the conductor spec takes
 * whichever side is free.
 */
export type WireTextItem = { text: string; style: TextStyle; w: number; h: number; x: number; y: number; rotation: number; tick?: [Pt, Pt]; spec?: boolean };
const wireTextCache = new WeakMap<Wire[], Map<string, { key: unknown[]; items: Map<string, WireTextItem[]> }>>();

/** Laid-out wire texts of a page (numbers, end markers, conductor specs), cached per content. */
export function wireTexts(doc: Doc, page: Page, styles: Styles, measure: Painter["measure"], kind: string, withSpec = true): Map<string, WireTextItem[]> {
  // one entry per measuring backend (canvas, PDF, label links …) so they do not evict each other
  const key = [styles, doc.wiring, doc.cables, page.elements, doc.defs, withSpec];
  let byKind = wireTextCache.get(page.wires);
  if (!byKind) wireTextCache.set(page.wires, (byKind = new Map()));
  let c = byKind.get(kind);
  if (!c || c.key.some((k, i) => k !== key[i])) byKind.set(kind, (c = { key, items: layoutWireTexts(doc, page, page.wires, styles, measure, withSpec, kind) }));
  return c.items;
}

function drawWireTexts(pt: Painter, doc: Doc, page: Page, wires: Wire[], styles: Styles, measure: Painter["measure"], o: DrawOpts, lod: number) {
  // layout covers the whole page (stable while panning, independent of culling), cached per content
  const c = { items: wireTexts(doc, page, styles, measure, pt.kind ?? "canvas") };
  const ticks = new PathBuilder();
  let nTicks = 0;
  for (const w of wires) {
    const items = c.items.get(w.id);
    if (!items) continue;
    const tint = o.tint?.get(w.id);
    for (const it of items) {
      if (it.spec && lod <= 0.5) continue; // conductor specs are too small to read when zoomed out
      drawLaidText(pt, { text: it.text, x: it.x, y: it.y, rotation: it.rotation, style: it.style, w: it.w, h: it.h }, o.alpha, tint);
      if (it.tick) {
        ticks.M(it.tick[0].x, it.tick[0].y).L(it.tick[1].x, it.tick[1].y);
        nTicks++;
      }
    }
  }
  if (nTicks) pt.stroke(ticks.build(), { color: styles.graphics.wire.color, width: 0.8, cap: "round", minPx: 1, alpha: o.alpha });
}

function layoutWireTexts(doc: Doc, page: Page, wires: Wire[], styles: Styles, measure: Painter["measure"], withSpec: boolean, kind: string): Map<string, WireTextItem[]> {
  const result = new Map<string, WireTextItem[]>();
  const ws = wiringOf(doc);
  const numberAt = ws.numberAt ?? "middle";
  const num = styles.text.wireLabel;
  const info = styles.text.wireInfo ?? num;
  const endStyle: TextStyle = { ...num, background: null };
  const sizeOf = (st: TextStyle) => st.size * PT;
  // every text placed on this page so far (all wires), in a coarse grid for collision checks
  const CELL = 24;
  const grid = new Map<string, Rect[]>();
  const cells = (r: Rect, f: (k: string) => void) => {
    for (let gx = Math.floor(r.x / CELL); gx <= Math.floor((r.x + r.w) / CELL); gx++) for (let gy = Math.floor(r.y / CELL); gy <= Math.floor((r.y + r.h) / CELL); gy++) f(gx + "," + gy);
  };
  const taken = {
    push(r: Rect) {
      cells(r, (k) => (grid.get(k) ?? grid.set(k, []).get(k)!).push(r));
    },
  };
  type Seg = { a: Pt; b: Pt; len: number; horizontal: boolean; ux: number; uy: number };
  type Item = { text: string; style: TextStyle; w: number; h: number; seg: number; c: number; side: 0 | 1; spec?: boolean; rect?: Rect };
  const rectOf = (sg: Seg, it: Item): Rect => {
    const p = { x: sg.a.x + sg.ux * it.c, y: sg.a.y + sg.uy * it.c };
    const above = it.side === 0;
    return sg.horizontal ? { x: p.x - it.w / 2, y: above ? p.y - it.h - 1 : p.y + 1.5, w: it.w, h: it.h } : { x: above ? p.x - it.h - 1 : p.x + 1.5, y: p.y - it.w / 2, w: it.h, h: it.w };
  };
  // component texts (references, names, info block) are obstacles too
  for (const e of page.elements) {
    const def = doc.defs[e.defId];
    if (!def) continue;
    for (const t of cachedElementTexts(e, symbolFor(def), styles, measure, kind)) taken.push(textBounds(t));
  }
  const overlaps = (r: Rect) => {
    let hit = false;
    cells(r, (k) => {
      if (!hit) hit = !!grid.get(k)?.some((q) => r.x < q.x + q.w + 0.5 && r.x + r.w + 0.5 > q.x && r.y < q.y + q.h + 0.5 && r.y + r.h + 0.5 > q.y);
    });
    return hit;
  };
  type Ctx = { w: Wire; segs: Seg[]; anchor: { seg: number; d: number }; placed: Item[] };
  const ctxs: Ctx[] = [];
  for (const w of wires) {
    if (w.pts.length < 2) continue;
    const segs: Seg[] = w.pts.slice(0, -1).map((a, i) => {
      const b = w.pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      return { a, b, len, horizontal: Math.abs(b.y - a.y) <= Math.abs(b.x - a.x), ux: (b.x - a.x) / (len || 1), uy: (b.y - a.y) / (len || 1) };
    });
    ctxs.push({ w, segs, anchor: wireTextAnchorSeg(doc, w, styles, measure), placed: [] });
  }
  const mk = (text: string, style: TextStyle) => ({ text, style, w: measure(text, sizeOf(style), style.font, style.weight), h: sizeOf(style) * style.lineHeight });
  /** try the candidate positions in order; the first one inside the segment and clear of other texts wins */
  const place = (cx: Ctx, base: Omit<Item, "c" | "side">, cands: [number, 0 | 1][]): boolean => {
    const sg = cx.segs[base.seg];
    for (const [c, side] of cands) {
      const it: Item = { ...base, c, side };
      if (c - it.w / 2 < -0.5 || c + it.w / 2 > sg.len + 0.5) continue;
      const r = rectOf(sg, it);
      if (overlaps(r)) continue;
      it.rect = r;
      taken.push(r);
      cx.placed.push(it);
      return true;
    }
    return false;
  };
  const slides = (len: number, from: number, sides: (0 | 1)[]): [number, 0 | 1][] => {
    const out: [number, 0 | 1][] = [];
    for (const side of sides) out.push([from, side]);
    // slide at most ~12 text heights along the wire: beyond that the text no longer reads as belonging here
    for (let k = 4; k < Math.min(len, 96); k += 4) for (const d of [k, -k]) for (const side of sides) out.push([from + d, side]);
    return out;
  };

  /*
   * Parallel runs (wires side by side, like a bus) get their texts in one column: every wire of the
   * group puts its number at the same spot along the run and its conductor spec at the same spot too.
   * Placement is tried for the whole group at once; if no common spot is free the wires fall back to
   * their own positions.
   */
  type Group = { members: Ctx[]; at: number };
  const axisOf = (sg: Seg) => (sg.horizontal ? { lo: Math.min(sg.a.x, sg.b.x), hi: Math.max(sg.a.x, sg.b.x), perp: sg.a.y } : { lo: Math.min(sg.a.y, sg.b.y), hi: Math.max(sg.a.y, sg.b.y), perp: sg.a.x });
  const cAt = (sg: Seg, at: number) => (sg.horizontal ? (at - sg.a.x) / (sg.ux || 1) : (at - sg.a.y) / (sg.uy || 1));
  const groups: Group[] = [];
  {
    const need = (cx: Ctx) => {
      const spec = withSpec ? wireAnnotation(doc, cx.w) : null;
      return Math.max(cx.w.label ? mk(cx.w.label, num).w : 0, spec ? mk(spec, info).w + 6 : 0) + 8;
    };
    for (const horizontal of [true, false]) {
      const cand = ctxs
        .filter((cx) => cx.w.labelPos === undefined && cx.segs[cx.anchor.seg].horizontal === horizontal && cx.segs[cx.anchor.seg].len > 0)
        .map((cx) => ({ cx, ...axisOf(cx.segs[cx.anchor.seg]), need: need(cx) }))
        .sort((a, b) => a.perp - b.perp || a.lo - b.lo);
      const used = new Set<Ctx>();
      for (let i = 0; i < cand.length; i++) {
        if (used.has(cand[i].cx)) continue;
        const g = [cand[i]];
        let lo = cand[i].lo, hi = cand[i].hi, need = cand[i].need, last = cand[i].perp;
        for (let j = i + 1; j < cand.length; j++) {
          const c = cand[j];
          if (used.has(c.cx) || c.perp === last) continue;
          if (c.perp - last > 50) break;
          const nlo = Math.max(lo, c.lo), nhi = Math.min(hi, c.hi), nneed = Math.max(need, c.need);
          if (nhi - nlo < nneed) continue;
          g.push(c);
          (lo = nlo), (hi = nhi), (need = nneed), (last = c.perp);
        }
        if (g.length < 2) continue;
        for (const m of g) used.add(m.cx);
        groups.push({ members: g.map((m) => m.cx), at: (lo + hi) / 2 });
      }
    }
  }
  /** one position for the whole group (same shift along the run, same side); all or nothing */
  const placeGroup = (g: Group, make: (cx: Ctx) => { text: string; style: TextStyle; w: number; h: number; spec?: boolean } | null, sides: (0 | 1)[]): Set<Ctx> => {
    const items = g.members.map((cx) => ({ cx, t: make(cx) })).filter((x) => x.t) as { cx: Ctx; t: NonNullable<ReturnType<typeof make>> }[];
    if (items.length < 2) return new Set();
    const shifts = [0];
    for (let k = 4; k < 96; k += 4) shifts.push(k, -k);
    for (const d of shifts)
      for (const side of sides) {
        const trial: { cx: Ctx; it: Item; r: Rect }[] = [];
        let ok = true;
        for (const { cx, t } of items) {
          const sg = cx.segs[cx.anchor.seg];
          const it: Item = { ...t, seg: cx.anchor.seg, c: cAt(sg, g.at + d), side };
          if (it.c - it.w / 2 < -0.5 || it.c + it.w / 2 > sg.len + 0.5) {
            ok = false;
            break;
          }
          const r = rectOf(sg, it);
          if (overlaps(r) || trial.some((q) => r.x < q.r.x + q.r.w + 0.5 && r.x + r.w + 0.5 > q.r.x && r.y < q.r.y + q.r.h + 0.5 && r.y + r.h + 0.5 > q.r.y)) {
            ok = false;
            break;
          }
          trial.push({ cx, it, r });
        }
        if (!ok) continue;
        for (const { cx, it, r } of trial) {
          it.rect = r;
          taken.push(r);
          cx.placed.push(it);
        }
        return new Set(trial.map((q) => q.cx));
      }
    return new Set();
  };

  // pass 1: wire numbers in the middle (the most important text of a wire)
  const numbered = new Set<Ctx>();
  if (num.visible && numberAt !== "ends")
    for (const g of groups) for (const cx of placeGroup(g, (cx) => (cx.w.label ? mk(cx.w.label, num) : null), numberAt === "both" ? [0] : [0, 1])) numbered.add(cx);
  if (num.visible && numberAt !== "ends")
    for (const cx of ctxs) {
      if (!cx.w.label || numbered.has(cx)) continue;
      const t = mk(cx.w.label, num);
      const len = cx.segs[cx.anchor.seg].len;
      place(cx, { ...t, seg: cx.anchor.seg }, slides(len, cx.anchor.d, numberAt === "both" ? [0] : [0, 1]));
    }
  // pass 2: end markers, just clear of each end
  if (num.visible)
    for (const cx of ctxs)
      for (const end of ["a", "b"] as const) {
        const text = wireEndLabel(doc, page, cx.w, end, numberAt !== "middle", !!ws.destination);
        if (!text) continue;
        const t = mk(text, endStyle);
        const seg = end === "a" ? 0 : cx.segs.length - 1;
        const len = cx.segs[seg].len;
        if (len < 1) continue;
        const d = t.w / 2 + 3;
        const dir = end === "a" ? 1 : -1;
        const start = end === "a" ? d : len - d;
        const cands: [number, 0 | 1][] = [];
        for (let k = 0; k <= Math.min(len / 2, 48); k += 4) cands.push([start + dir * k, 0], [start + dir * k, 1]);
        place(cx, { ...t, seg }, cands);
      }
  // pass 3: conductor color / cross-section: the other side of the wire at the same spot, else the nearest free place
  const specced = new Set<Ctx>();
  if (withSpec && (ws.showColor || ws.showSection) && info.visible)
    for (const g of groups)
      for (const cx of placeGroup(g, (cx) => {
        const spec = wireAnnotation(doc, cx.w);
        return spec ? { ...mk(spec, info), spec: true } : null;
      }, [1, 0]))
        specced.add(cx);
  if (withSpec && (ws.showColor || ws.showSection) && info.visible)
    for (const cx of ctxs) {
      const spec = wireAnnotation(doc, cx.w);
      if (!spec || specced.has(cx)) continue;
      const t = mk(spec, info);
      const order = [cx.anchor.seg, ...cx.segs.map((_, i) => i).filter((i) => i !== cx.anchor.seg).sort((x, y) => cx.segs[y].len - cx.segs[x].len)];
      for (const seg of order) {
        const len = cx.segs[seg].len;
        if (len < t.w + 4) continue;
        if (place(cx, { ...t, seg, spec: true }, slides(len, seg === cx.anchor.seg ? cx.anchor.d : len / 2, [1, 0]))) break;
      }
    }

  for (const { w, segs, placed } of ctxs) {
    if (!placed.length) continue;
    result.set(
      w.id,
      placed.map((it) => {
        const sg = segs[it.seg];
        const r = it.rect!;
        const out: WireTextItem = sg.horizontal
          ? { text: it.text, style: it.style, w: it.w, h: it.h, x: r.x + it.style.dx, y: r.y + it.style.dy, rotation: 0 }
          : { text: it.text, style: it.style, w: it.w, h: it.h, x: r.x + it.style.dx, y: r.y + r.h + it.style.dy, rotation: 270 };
        if (it.spec) out.spec = true;
        if (it.spec && ws.tick) {
          // tick through the wire just before the text
          const c = it.c - it.w / 2 - 2.5;
          const q = { x: sg.a.x + sg.ux * c, y: sg.a.y + sg.uy * c };
          out.tick = [{ x: q.x - 1.8, y: q.y + 1.8 }, { x: q.x + 1.8, y: q.y - 1.8 }];
        }
        return out;
      }),
    );
  }
  return result;
}

/** Segment + distance along it where the number and the conductor spec are centred. */
function wireTextAnchorSeg(doc: Doc, w: Wire, styles: Styles, measure: Painter["measure"]): { seg: number; d: number } {
  const { p } = wireTextAnchor(doc, w, styles, measure);
  let best = { seg: 0, d: 0, dist: Infinity };
  for (let i = 0; i < w.pts.length - 1; i++) {
    const a = w.pts[i], b = w.pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len)));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    if (dist < best.dist) best = { seg: i, d: t * len, dist };
  }
  return { seg: best.seg, d: best.d };
}


/** Where a wire's number and conductor annotation sit (shared by rendering and label links). */
export function wireTextAnchor(doc: Doc, w: Wire, styles: Styles, measure: Painter["measure"]): { p: Pt; horizontal: boolean } {
  if (w.labelPos !== undefined) return pointAlong(w.pts, w.labelPos);
  const num = styles.text.wireLabel, info = styles.text.wireInfo ?? num;
  const nw = w.label ? measure(w.label, num.size * PT, num.font, num.weight) : 0;
  const spec = wireAnnotation(doc, w);
  const sw = spec ? measure(spec, info.size * PT, info.font, info.weight) : 0;
  return annotationAnchor(w, Math.max(nw, sw), 0.5);
}
