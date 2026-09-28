/**
 * AI-drawn symbols: the JSON the model returns (a small, strict drawing language) and its
 * conversion into a Volt / QElectroTech element definition.
 *
 * Units are diagram units: 10 = one grid square. The symbol is drawn around the origin, pins sit
 * on the 5-unit grid at the end of their lead lines, and `direction` is the side the wire leaves.
 */
import type { ElementDef, Orient, PinDef, Prim, PrimStyle } from "@/core/model";
import { blankDef, finalizeDef, newUuid } from "./elmt-tools";

export type AiShape = {
  kind: "line" | "rect" | "circle" | "ellipse" | "arc" | "polyline" | "polygon" | "text";
  points: { x: number; y: number }[];
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  start_deg: number | null;
  sweep_deg: number | null;
  text: string | null;
  size: number | null;
  filled: boolean;
  dashed: boolean;
};
export type AiPin = { x: number; y: number; direction: Orient; number: string; name: string };
export type AiSymbol = {
  name: string;
  category: string;
  prefix: string;
  description: string;
  link_type: "simple" | "master" | "slave" | "terminal";
  shapes: AiShape[];
  pins: AiPin[];
  notes: string;
};

const num = { type: "number" };
const numOrNull = { type: ["number", "null"] };
/** JSON schema for OpenAI structured outputs (strict: every property required, no extras). */
export const AI_SYMBOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "category", "prefix", "description", "link_type", "shapes", "pins", "notes"],
  properties: {
    name: { type: "string", description: "Short English name, e.g. 'Contactor coil 24 V DC'" },
    category: { type: "string", description: "Library folder, e.g. 'Relays & contactors/Coils', 'Connectors', 'Sensors'" },
    prefix: { type: "string", description: "IEC 81346 reference letter(s): K, Q, F, X, M, H, S, B, T, G, P, R, C, U, A…" },
    description: { type: "string", description: "One sentence: what the symbol represents" },
    link_type: { type: "string", enum: ["simple", "master", "slave", "terminal"], description: "master = coil (has contacts elsewhere), slave = contact of a master, terminal = terminal block, else simple" },
    shapes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "points", "x", "y", "w", "h", "start_deg", "sweep_deg", "text", "size", "filled", "dashed"],
        properties: {
          kind: { type: "string", enum: ["line", "rect", "circle", "ellipse", "arc", "polyline", "polygon", "text"] },
          points: { type: "array", items: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: num, y: num } }, description: "line: 2 points; polyline / polygon: 2+ points; else []" },
          x: { ...numOrNull, description: "rect / circle / ellipse / arc: left of the bounding box; text: left of the baseline" },
          y: { ...numOrNull, description: "rect / circle / ellipse / arc: top of the bounding box; text: baseline" },
          w: { ...numOrNull, description: "width of the bounding box (circle: diameter)" },
          h: { ...numOrNull, description: "height of the bounding box (circle: diameter)" },
          start_deg: { ...numOrNull, description: "arc: start angle in degrees, 0 = 3 o'clock, counter-clockwise" },
          sweep_deg: { ...numOrNull, description: "arc: sweep in degrees, counter-clockwise positive" },
          text: { type: ["string", "null"], description: "text: fixed text drawn in the symbol (not the reference)" },
          size: { ...numOrNull, description: "text: font size, usually 6–9" },
          filled: { type: "boolean", description: "solid black fill (arrow heads, dots)" },
          dashed: { type: "boolean", description: "dashed line (mechanical links)" },
        },
      },
    },
    pins: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "direction", "number", "name"],
        properties: {
          x: num,
          y: num,
          direction: { type: "string", enum: ["n", "e", "s", "w"], description: "side the wire leaves: n = up, s = down, e = right, w = left" },
          number: { type: "string", description: "terminal marking, e.g. 1, 2, A1, A2, 13, 14, L1, PE" },
          name: { type: "string", description: "function name, or same as number" },
        },
      },
    },
    notes: { type: "string", description: "Assumptions made, in one or two short sentences" },
  },
} as const;

export const AI_SYSTEM_PROMPT = `You draw electrical schematic symbols for Volt, a QElectroTech-compatible editor.
Output one symbol as JSON matching the schema. Follow IEC 60617 (or the style the user asks for / sketches).

Coordinate system: x to the right, y DOWN. Unit = 1; the diagram grid is 10. Draw the symbol centred near (0, 0).
Typical sizes: contact or coil 20–40 tall, motor circle 30–40 diameter, connector/PLC boxes 10 per pin row.
Pins: put every connection point exactly on a multiple of 10 (5 only if unavoidable), at the OUTER end of a
straight lead line of length 10 that you also draw. direction = the side the wire leaves (n up, s down, e right, w left).
Vertical symbols (contacts, coils, fuses, lamps, motors) have pins at top (n) and bottom (s) on x = 0.
Boxes with many pins: pins on the left (w) and right (e) sides, one per 10 units, numbered as asked.
Use lines, rects, circles, ellipses, arcs, polylines and polygons; filled only for small solid marks.
Use text only for fixed markings inside the symbol (M, 3~, A1/A2 near pins, +/-, V, A). Never draw the
reference label (K1, Q1…): the editor adds it. Keep text size 6–9.
Keep it clean and minimal like a standard library symbol: straight lines, no shading, no decoration.
If a sketch or picture is given, reproduce its shape faithfully but tidy it onto the grid.
If the request is ambiguous, pick the most common industrial interpretation and say so in notes.`;

const S = (o: Partial<PrimStyle> = {}): PrimStyle => ({ lineStyle: "normal", lineWeight: "normal", filling: "none", color: "black", ...o });
const r2 = (v: number) => Math.round(v * 2) / 2;
const clampN = (v: number | null | undefined, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(-600, Math.min(600, v)) : d);

/** Convert the model's symbol into an element definition (validated, snapped, with a reference label). */
export function aiSymbolToDef(sym: AiSymbol): { def: ElementDef; warnings: string[] } {
  const warnings: string[] = [];
  const prims: Prim[] = [];
  for (const s of sym.shapes.slice(0, 400)) {
    const style = S({ lineStyle: s.dashed ? "dashed" : "normal", filling: s.filled ? "black" : "none" });
    const pts = (s.points ?? []).slice(0, 200).map((p) => ({ x: r2(clampN(p.x)), y: r2(clampN(p.y)) }));
    const x = r2(clampN(s.x)), y = r2(clampN(s.y)), w = r2(Math.abs(clampN(s.w, 10))), h = r2(Math.abs(clampN(s.h, s.kind === "circle" ? clampN(s.w, 10) : 10)));
    switch (s.kind) {
      case "line":
        if (pts.length >= 2) prims.push({ t: "line", x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, end1: "none", end2: "none", len1: 1.5, len2: 1.5, style });
        break;
      case "polyline":
      case "polygon":
        if (pts.length >= 2) prims.push({ t: "polygon", pts, closed: s.kind === "polygon", style });
        break;
      case "rect":
        prims.push({ t: "rect", x, y, w, h, rx: 0, ry: 0, style });
        break;
      case "circle":
        prims.push({ t: "ellipse", x, y, w, h: w, style });
        break;
      case "ellipse":
        prims.push({ t: "ellipse", x, y, w, h, style });
        break;
      case "arc":
        prims.push({ t: "arc", x, y, w, h, start: Math.round(clampN(s.start_deg, 0)), angle: Math.round(clampN(s.sweep_deg, 180)), style });
        break;
      case "text":
        if (s.text?.trim()) prims.push({ t: "text", x, y, text: s.text.trim().slice(0, 40), size: Math.max(4, Math.min(20, clampN(s.size, 7))), rotation: 0, color: "#000000" });
        break;
    }
  }
  if (sym.shapes.length > 400) warnings.push("Only the first 400 shapes were kept.");
  const pins: PinDef[] = [];
  const seen = new Set<string>();
  for (const p of sym.pins.slice(0, 128)) {
    const px = Math.round(clampN(p.x) / 5) * 5, py = Math.round(clampN(p.y) / 5) * 5;
    if (px !== p.x || py !== p.y) warnings.push(`Pin ${p.number || "?"} moved onto the grid.`);
    const k = `${px},${py}`;
    if (seen.has(k)) {
      warnings.push(`Two pins at ${k}; one was dropped.`);
      continue;
    }
    seen.add(k);
    const orient: Orient = ["n", "e", "s", "w"].includes(p.direction) ? p.direction : "n";
    pins.push({ id: newUuid(), x: px, y: py, orient, number: (p.number || "").slice(0, 16), name: (p.name || p.number || "").slice(0, 32), type: "Generic" });
  }
  if (!prims.length) warnings.push("The model returned no drawing.");
  // reference label to the right of the drawing, at the top
  let maxX = 0, minY = 0;
  for (const p of prims) {
    const xs = p.t === "line" ? [p.x1, p.x2] : p.t === "polygon" ? p.pts.map((q) => q.x) : "w" in p ? [p.x, p.x + p.w] : [p.x];
    const ys = p.t === "line" ? [p.y1, p.y2] : p.t === "polygon" ? p.pts.map((q) => q.y) : [p.y];
    maxX = Math.max(maxX, ...xs);
    minY = Math.min(minY, ...ys);
  }
  prims.push({ t: "dyntext", x: Math.round(maxX + 6), y: Math.round(minY), from: "ElementInfo", info: "label", text: "", size: 9, rotation: 0, halign: "left", valign: "top", frame: false, width: -1, uuid: newUuid() });
  const name = (sym.name || "AI element").trim().slice(0, 80);
  const def = finalizeDef(
    blankDef(name, {
      prims,
      pins,
      linkType: ["simple", "master", "slave", "terminal"].includes(sym.link_type) ? sym.link_type : "simple",
      prefix: (sym.prefix || "").replace(/[^A-Za-z]/g, "").slice(0, 4),
      category: (sym.category || "Custom").slice(0, 80),
      info: { label: "", description: (sym.description || "").slice(0, 200) },
    }),
  );
  return { def, warnings };
}
