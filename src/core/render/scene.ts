import type { Doc, ElemInst, ElementDef, FreeText, Junction, Page, PinDef, PlacedText, Pt, Rect, Styles, TextStyle, TitleBlockTemplate, Wire } from "../model";
import { effectiveText, projectStyles } from "../styles";
import { elemMatrix, pointAlong, rotOrient, toScene, transformRect, unionRect } from "../geometry";
import { titleBlockColumnWidths, titleBlockHeight } from "../qet/titleblock";
import { defaultTitleBlock } from "../doc";
import { DASHES, PathBuilder, type Painter, type PathData, type StrokeStyle } from "./painter";
import { PT, symbolFor, type CompiledSymbol } from "./symbol";

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
    const baseRot = e.rot * 90 + (style.rotation || 0);
    // element rotation also rotates the text box origin; keep readable
    const r = readable(p.x, p.y, baseRot, w, h);
    out.push({ text, x: r.x, y: r.y, rotation: r.rot, style, w, h });
  }
  // definition dynamic texts are templates: QElectroTech (≥0.7) and Volt instantiate them on the
  // element when placed, so they are only drawn for legacy instances that carry no texts at all.
  const instantiated = e.texts.length > 0;
  for (const ct of sym.texts) {
    if (!ct.dyn || instantiated) continue;
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
    out.push({ text, x: r.x, y: r.y, rotation: r.rot, style, w, h });
  }
  return out;
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
const groupCache = new WeakMap<Wire[], { styles: Styles; groups: WireGroup[] }>();
function wireGroups(styles: Styles, wires: Wire[], tint?: Map<string, string>, dim?: Set<string>): WireGroup[] {
  const cacheable = !tint && !dim;
  if (cacheable) {
    const c = groupCache.get(wires);
    if (c && c.styles === styles) return c.groups;
  }
  const m = new Map<string, WireGroup>();
  for (const w of wires) {
    if (w.pts.length < 2) continue;
    const st = wireStroke(styles, w, tint?.get(w.id));
    const d = !!dim?.has(w.id);
    const k = `${st.color}|${st.width}|${st.dash?.join(",") ?? ""}|${d}`;
    let g = m.get(k);
    if (!g) m.set(k, (g = { style: st, paths: [], dim: d }));
    g.paths.push(wirePath(w));
  }
  const groups = [...m.values()];
  if (cacheable) groupCache.set(wires, { styles, groups });
  return groups;
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

export function wireStroke(styles: Styles, w: Wire, tint?: string): StrokeStyle {
  const base = w.bus ? styles.graphics.bus : styles.graphics.wire;
  const o = w.override ?? {};
  return {
    color: tint ?? o.color ?? base.color,
    width: o.width ?? base.width,
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
    pt.stroke(path, { color: s.color, width: s.width, dash: DASHES[s.dash], minPx: 1 });
  }
  pt.end?.();

  // wires — cached paths, batched per stroke style (one native stroke per style on canvas)
  const wires = o.wires ?? page.wires;
  pt.begin?.("wires");
  const groups = wireGroups(styles, wires, o.tint, o.dim);
  for (const g of groups) {
    const st = { ...g.style, alpha: g.dim ? 0.25 : o.alpha };
    if (pt.strokeMany) pt.strokeMany(g.paths, st);
    else for (const p of g.paths) pt.stroke(p, st);
  }
  // wire labels
  if (lod > 0.35) {
    for (const w of wires) {
      const text = w.label || w.cable;
      if (!text || w.pts.length < 2) continue;
      const role = w.label ? "wireLabel" : "cableLabel";
      const st = styles.text[role];
      if (!st.visible) continue;
      const size = st.size * PT;
      const { p, horizontal } = pointAlong(w.pts, w.labelPos ?? 0.5);
      const tw = measure(text, size, st.font, st.weight);
      const h = size * st.lineHeight;
      if (horizontal) drawLaidText(pt, { text, x: p.x - tw / 2 + st.dx, y: p.y - h - 1 + st.dy, rotation: 0, style: st, w: tw, h }, o.alpha, o.tint?.get(w.id));
      else drawLaidText(pt, { text, x: p.x - h - 1 + st.dx, y: p.y + tw / 2 + st.dy, rotation: 270, style: st, w: tw, h }, o.alpha, o.tint?.get(w.id));
    }
  }
  pt.end?.();

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
  pt.end?.();

  // free texts
  if (lod > 0.25) {
    pt.begin?.("texts");
    for (const t of o.texts ?? page.texts) {
      const st = effectiveText(styles, t.role, t.override);
      if (!st.visible) continue;
      const size = st.size * PT;
      const lines = t.text.split("\n");
      lines.forEach((line, i) => {
        const w = measure(line, size, st.font, st.weight);
        drawLaidText(pt, { text: line, x: t.x + 4 + st.dx, y: t.y + 4 + st.dy + i * size * st.lineHeight, rotation: st.rotation, style: st, w, h: size }, o.alpha, o.tint?.get(t.id));
      });
    }
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
  if (o.lod > 0.3) {
    for (const t of sym.texts) {
      if (t.dyn) continue;
      pt.text({ text: t.text, x: t.x, y: t.y, size: t.size, font: styles.text.componentName.font, color: o.tint ?? t.color, baseline: t.baseline, rotation: t.rotation, alpha: o.alpha });
    }
  }
  pt.restore();

  if (o.lod > 0.3) {
    for (const lt of cachedElementTexts(e, sym, styles, o.measure, o.measureKey ?? pt.kind)) drawLaidText(pt, lt, o.alpha, o.tint);
    const showNum = e.showPinNumbers ?? styles.text.pinNumber.visible;
    const showName = e.showPinNames ?? styles.text.pinName.visible;
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
