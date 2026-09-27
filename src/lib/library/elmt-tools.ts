/**
 * Isomorphic helpers for library elements (used by the API routes, the seed and the symbol editor).
 * No server-only imports here.
 */
import type { ElementDef, PinDef, Prim, Pt, Rect } from "@/core/model";
import { PT } from "@/core/render/symbol";
import { approxMeasure } from "@/core/render/svg";

export const LINK_TYPES = [
  { id: "simple", label: "Simple (standalone symbol)" },
  { id: "master", label: "Master (e.g. relay coil — has cross-referenced contacts)" },
  { id: "slave", label: "Slave (e.g. contact of a relay)" },
  { id: "next_report", label: "Next folio report (outgoing arrow)" },
  { id: "previous_report", label: "Previous folio report (incoming arrow)" },
  { id: "terminal", label: "Terminal (terminal block)" },
  { id: "thumbnail", label: "Thumbnail (decorative)" },
] as const;

/** Common QElectroTech element information keys (dynamic text sources). */
export const INFO_KEYS = [
  { id: "label", label: "Reference (label)" },
  { id: "comment", label: "Comment" },
  { id: "function", label: "Function" },
  { id: "location", label: "Location" },
  { id: "manufacturer", label: "Manufacturer" },
  { id: "rating", label: "Rating" },
  { id: "manufacturer_reference", label: "Manufacturer part number" },
  { id: "description", label: "Description" },
  { id: "designation", label: "Designation" },
  { id: "machine_manufacturer_reference", label: "Machine manufacturer reference" },
  { id: "supplier", label: "Supplier" },
  { id: "quantity", label: "Quantity" },
  { id: "unity", label: "Unit" },
  { id: "plant", label: "Plant" },
  { id: "auxiliary1", label: "Auxiliary 1" },
  { id: "auxiliary2", label: "Auxiliary 2" },
  { id: "formula", label: "Formula" },
] as const;

export const PIN_TYPES = ["Generic", "Inner", "Outer"] as const;

export function newUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Normalise a slash category path ("a\\b//c/" → "a/b/c"). */
export function normCategory(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((x) => x.trim())
    .filter((x) => x && x !== "." && x !== "..")
    .join("/");
}

/** Category from an archive / relative file path: all folders except the file name. */
export function categoryFromPath(path: string): string {
  const parts = normCategory(path).split("/");
  parts.pop();
  return parts.join("/");
}

export function slugify(s: string): string {
  const x = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return x || "element";
}

/** Human label for a category path segment ("10_electric" → "Electric"). */
export function categoryLabel(seg: string): string {
  const s = seg.replace(/^\d+[_-]/, "").replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : seg;
}

/** Best-effort reference prefix from QET kind information / link type / names. */
export function guessPrefix(def: Pick<ElementDef, "kind" | "linkType" | "name" | "names" | "category">): string {
  const type = (def.kind.type ?? "").toLowerCase();
  const text = `${def.name} ${def.names.en ?? ""} ${def.names.fr ?? ""} ${def.category}`.toLowerCase();
  if (type === "coil" || def.linkType === "master") return "K";
  if (type === "protection") return "F";
  if (def.linkType === "terminal" || /terminal|borne|barette|klemm/.test(text)) return "X";
  if (/motor|moteur/.test(text)) return "M";
  if (/lamp|lampe|light|voyant/.test(text)) return "H";
  if (/disjonct|breaker|fuse|fusible|sectionneur|isolator|disconnect/.test(text)) return "Q";
  if (/diode|schottky/.test(text)) return "V";
  if (/condensat|capacitor/.test(text)) return "C";
  if (/ntc|resist|ptc/.test(text)) return "R";
  if (/push|poussoir|button|switch|inter/.test(text)) return "S";
  if (/bell|sonnerie|buzzer|horn/.test(text)) return "H";
  if (/transfo/.test(text)) return "T";
  if (/plc|automate|ihm|hmi|screen|ecran/.test(text)) return "A";
  return "";
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export function textBox(p: Extract<Prim, { t: "text" }>): Rect {
  const size = p.size * PT;
  const w = approxMeasure(p.text, size);
  // x,y = baseline-left
  return rotBox({ x: p.x, y: p.y - size * 0.8, w, h: size }, p.rotation, { x: p.x, y: p.y });
}

export function dynTextBox(p: Extract<Prim, { t: "dyntext" }>, shown?: string): Rect {
  const size = p.size * PT;
  const txt = shown ?? (p.text || (p.info ? `%{${p.info}}` : "text"));
  const w = p.width > 0 ? p.width : approxMeasure(txt, size) + 8;
  return rotBox({ x: p.x, y: p.y, w, h: size * 1.2 + 8 }, p.rotation, { x: p.x, y: p.y });
}

function rotBox(r: Rect, deg: number, about: Pt): Rect {
  if (!deg) return r;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const pts = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((p) => ({ x: about.x + (p.x - about.x) * c - (p.y - about.y) * s, y: about.y + (p.x - about.x) * s + (p.y - about.y) * c }));
  return boundsOf(pts);
}

export function boundsOf(pts: Pt[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionR(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Accurate bounds of an arc (only the swept part). */
function arcBounds(p: Extract<Prim, { t: "arc" }>): Rect {
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2, rx = p.w / 2, ry = p.h / 2;
  const pts: Pt[] = [];
  const n = Math.max(8, Math.ceil(Math.abs(p.angle) / 5));
  for (let i = 0; i <= n; i++) {
    const deg = p.start + (p.angle * i) / n;
    const a = (-deg * Math.PI) / 180;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return boundsOf(pts);
}

export function primBounds(p: Prim, opts: { dyn?: boolean } = {}): Rect | null {
  switch (p.t) {
    case "line":
      return boundsOf([
        { x: p.x1, y: p.y1 },
        { x: p.x2, y: p.y2 },
      ]);
    case "rect":
    case "ellipse":
      return { x: Math.min(p.x, p.x + p.w), y: Math.min(p.y, p.y + p.h), w: Math.abs(p.w), h: Math.abs(p.h) };
    case "arc":
      return arcBounds(p);
    case "polygon":
      return p.pts.length ? boundsOf(p.pts) : null;
    case "text":
      return textBox(p);
    case "dyntext":
      return opts.dyn ? dynTextBox(p) : null;
  }
}

export function pinBounds(pin: PinDef): Rect {
  // dock point + 4 unit stub towards the body
  const v = pin.orient === "n" ? [0, 4] : pin.orient === "s" ? [0, -4] : pin.orient === "e" ? [-4, 0] : [4, 0];
  return boundsOf([
    { x: pin.x, y: pin.y },
    { x: pin.x + v[0], y: pin.y + v[1] },
  ]);
}

/** Geometric bounds used by QET for the element size: primitives + static texts + terminals (dynamic texts excluded). */
export function symbolBounds(def: Pick<ElementDef, "prims" | "pins">): Rect | null {
  let r: Rect | null = null;
  for (const p of def.prims) r = unionR(r, primBounds(p));
  for (const pin of def.pins) r = unionR(r, pinBounds(pin));
  return r;
}

/** Visual bounds (including dynamic texts) — for previews / zoom-to-fit. */
export function visualBounds(def: Pick<ElementDef, "prims" | "pins">): Rect | null {
  let r: Rect | null = null;
  for (const p of def.prims) r = unionR(r, primBounds(p, { dyn: true }));
  for (const pin of def.pins) r = unionR(r, pinBounds(pin));
  return r;
}

/**
 * QET element size & hotspot from the drawing (ElementScene::toXml()):
 * width/height rounded up to tens with a margin, hotspot = -(top-left) of the centred box.
 * Coordinates stay hotspot-relative (origin 0,0 = hotspot).
 */
export function computeFrame(def: Pick<ElementDef, "prims" | "pins">): { width: number; height: number; hotspotX: number; hotspotY: number } {
  const b = symbolBounds(def) ?? { x: -10, y: -10, w: 20, h: 20 };
  const rw = Math.round(b.w), rh = Math.round(b.h);
  let upw = Math.floor(rw / 10) * 10 + 10;
  if (rw % 10 > 6) upw += 10;
  let uph = Math.floor(rh / 10) * 10 + 10;
  if (rh % 10 > 6) uph += 10;
  const xm = Math.round(upw - b.w), ym = Math.round(uph - b.h);
  return { width: upw, height: uph, hotspotX: -Math.round(b.x - Math.trunc(xm / 2)), hotspotY: -Math.round(b.y - Math.trunc(ym / 2)) };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type Issue = { level: "error" | "warning"; message: string; target?: string };

export function validateDef(def: Pick<ElementDef, "prims" | "pins" | "names" | "linkType">): Issue[] {
  const out: Issue[] = [];
  const drawing = def.prims.filter((p) => p.t !== "text" && p.t !== "dyntext");
  if (!drawing.length) out.push({ level: "error", message: "The symbol has no drawing — add at least one line, rectangle, circle, arc or polygon." });
  if (!def.names.en?.trim()) out.push({ level: "error", message: "An English name is required." });
  const seen = new Map<string, number>();
  for (const p of def.pins) if (p.number.trim()) seen.set(p.number.trim(), (seen.get(p.number.trim()) ?? 0) + 1);
  for (const [n, c] of seen) if (c > 1) out.push({ level: "error", message: `Pin number “${n}” is used ${c} times — pin numbers must be unique.`, target: `pinnum:${n}` });
  def.pins.forEach((p, i) => {
    if (!p.number.trim() && !p.name.trim()) out.push({ level: "warning", message: `Pin ${i + 1} has no number or name.`, target: `pin:${p.id}` });
  });
  // pins stacked on the same point
  const at = new Map<string, number>();
  for (const p of def.pins) {
    const k = `${Math.round(p.x * 10)}|${Math.round(p.y * 10)}`;
    at.set(k, (at.get(k) ?? 0) + 1);
  }
  for (const [k, c] of at) if (c > 1) out.push({ level: "error", message: `${c} pins are placed on the same point (${k.split("|").map((v) => Number(v) / 10).join(", ")}).` });
  // pins not attached to the drawing: the stub's inner end should touch a primitive's box
  const body = drawing.map((p) => primBounds(p)).filter(Boolean) as Rect[];
  for (const p of def.pins) {
    const v = p.orient === "n" ? [0, 4] : p.orient === "s" ? [0, -4] : p.orient === "e" ? [-4, 0] : [4, 0];
    const inner = { x: p.x + v[0], y: p.y + v[1] };
    const near = body.some((r) => inner.x >= r.x - 1.5 && inner.x <= r.x + r.w + 1.5 && inner.y >= r.y - 1.5 && inner.y <= r.y + r.h + 1.5);
    if (body.length && !near) out.push({ level: "warning", message: `Pin ${p.number || p.name || "?"} is not connected to any drawing — it floats in empty space.`, target: `pin:${p.id}` });
    // pin pointing inwards
    const b = symbolBounds({ prims: drawing, pins: [] });
    if (b) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const out1 = p.orient === "n" ? p.y <= cy : p.orient === "s" ? p.y >= cy : p.orient === "e" ? p.x >= cx : p.x <= cx;
      if (!out1 && (b.w > 4 || b.h > 4)) out.push({ level: "warning", message: `Pin ${p.number || p.name || "?"} points into the symbol — check its orientation.`, target: `pin:${p.id}` });
    }
  }
  if (!def.pins.length && def.linkType !== "thumbnail") out.push({ level: "warning", message: "The element has no pins — wires cannot connect to it." });
  const b = symbolBounds(def);
  if (b && !(b.x <= 0 && b.y <= 0 && b.x + b.w >= 0 && b.y + b.h >= 0)) out.push({ level: "warning", message: "The origin (hotspot) is outside the symbol. Use “Center on origin” so the element places predictably." });
  const hasLabel = def.prims.some((p) => p.t === "dyntext" && p.from === "ElementInfo" && p.info === "label");
  if (!hasLabel && def.linkType !== "thumbnail") out.push({ level: "warning", message: "No reference text (label) — the component reference like “K1” will not be shown on diagrams." });
  for (const p of def.prims) {
    if ((p.t === "rect" || p.t === "ellipse") && (Math.abs(p.w) < 0.01 || Math.abs(p.h) < 0.01)) out.push({ level: "warning", message: `A ${p.t === "rect" ? "rectangle" : "ellipse"} has zero size.` });
    if (p.t === "line" && p.x1 === p.x2 && p.y1 === p.y2) out.push({ level: "warning", message: "A line has zero length." });
    if (p.t === "polygon" && p.pts.length < 2) out.push({ level: "warning", message: "A polygon has fewer than 2 points." });
  }
  return out;
}

/** Blank definition skeleton (hotspot at origin). */
export function blankDef(name: string, opts: Partial<ElementDef> = {}): ElementDef {
  return {
    id: "new",
    uuid: newUuid(),
    name,
    names: { en: name },
    width: 20,
    height: 20,
    hotspotX: 10,
    hotspotY: 10,
    linkType: "simple",
    prefix: "",
    category: "",
    prims: [],
    pins: [],
    info: {},
    kind: {},
    meta: {},
    ...opts,
  };
}

/**
 * Finalise a def before serialising: frame from the drawing; keeps xml for lossless patching.
 * With `prev` (the frame stored before editing) the previous frame is kept while the drawing still
 * fits inside it, so unchanged QElectroTech files keep their exact size/hotspot.
 */
export type Frame = { width: number; height: number; hotspotX: number; hotspotY: number };

export function effectiveFrame(def: Pick<ElementDef, "prims" | "pins">, prev?: Frame | null): Frame {
  if (prev && prev.width > 0 && prev.height > 0) {
    const b = symbolBounds(def);
    const x0 = -prev.hotspotX, y0 = -prev.hotspotY;
    if (!b || (b.x >= x0 - 0.01 && b.y >= y0 - 0.01 && b.x + b.w <= x0 + prev.width + 0.01 && b.y + b.h <= y0 + prev.height + 0.01)) return { width: prev.width, height: prev.height, hotspotX: prev.hotspotX, hotspotY: prev.hotspotY };
  }
  return computeFrame(def);
}

export function finalizeDef(def: ElementDef, prev?: Frame | null): ElementDef {
  return { ...def, ...effectiveFrame(def, prev), name: def.names.en || def.name };
}
