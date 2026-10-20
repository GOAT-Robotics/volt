/**
 * The kinds of shape people draw (text boxes, rounded boxes, flowchart forms, arrows …) and what
 * each one is stored as: a rectangle with a form / radius / text, a line or polyline with arrows.
 * Shared by the editor's shape tool and the MCP tools.
 */
import { SHAPE_FORMS, type Pt, type Shape, type ShapeForm } from "./model";
import { isOpenPath } from "./shape-geom";

/** shapes drawn in a box (two opposite corners) */
export const BOX_PRESETS = ["rect", "ellipse", "textbox", "rounded", ...SHAPE_FORMS] as const;
export type BoxPreset = (typeof BOX_PRESETS)[number];
/** shapes drawn through points */
export const PATH_PRESETS = ["line", "arrow", "polygon", "polyline"] as const;
export type PathPreset = (typeof PATH_PRESETS)[number];
export type ShapePreset = BoxPreset | PathPreset;

export const isBoxPreset = (k: string): k is BoxPreset => (BOX_PRESETS as readonly string[]).includes(k);
export const isForm = (k: string): k is ShapeForm => (SHAPE_FORMS as readonly string[]).includes(k);

export const PRESET_NAMES: Record<ShapePreset, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  textbox: "Text box",
  rounded: "Rounded box",
  diamond: "Diamond",
  hexagon: "Hexagon",
  triangle: "Triangle",
  parallelogram: "Parallelogram",
  cylinder: "Cylinder",
  document: "Document",
  line: "Line",
  arrow: "Arrow",
  polygon: "Polygon",
  polyline: "Polyline",
};

/** corner radius a rounded box gets */
export const DEFAULT_RADIUS = 8;

type Look = { color: string; width: number; dash: Shape["dash"]; fill: string | null };

/** A box shape between two opposite corners. */
export function boxShape(id: string, preset: BoxPreset, a: Pt, b: Pt, look: Look): Shape {
  const pts = [
    { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  ];
  const s: Shape = { id, kind: preset === "ellipse" ? "ellipse" : "rect", pts, color: look.color, width: look.width, dash: look.dash, fill: look.fill };
  if (preset === "rounded") s.radius = DEFAULT_RADIUS;
  if (isForm(preset)) s.form = preset;
  if (preset === "textbox") s.label = { text: "" };
  return s;
}

/** A line / arrow (two points) or polyline / polygon / bent arrow (more). */
export function pathShape(id: string, preset: PathPreset, pts: Pt[], look: Look): Shape {
  const open = preset !== "polygon";
  const kind: Shape["kind"] = pts.length === 2 && (preset === "line" || preset === "arrow") ? "line" : "polygon";
  const s: Shape = { id, kind, pts: pts.map((p) => ({ ...p })), color: look.color, width: look.width, dash: look.dash, fill: open ? null : look.fill };
  if (kind === "polygon") s.closed = !open;
  if (preset === "arrow") s.arrows = { end: true };
  return s;
}

/** What a shape is, in words: "Diamond", "Text box", "Arrow" … */
export function shapeName(s: Shape): string {
  if (s.image) return "Picture";
  if (s.kind === "rect") return s.form ? PRESET_NAMES[s.form] : s.radius ? "Rounded box" : s.label ? "Text box" : "Rectangle";
  if (s.kind === "ellipse") return "Ellipse";
  if (isOpenPath(s)) return s.arrows?.start || s.arrows?.end ? (s.kind === "line" ? "Arrow" : "Bent arrow") : s.kind === "line" ? "Line" : "Polyline";
  return "Polygon";
}

/** The preset a rectangle is drawn as (for switching its outline). */
export function boxPresetOf(s: Shape): BoxPreset | null {
  if (s.kind === "ellipse") return "ellipse";
  if (s.kind !== "rect" || s.image) return null;
  if (s.form) return s.form;
  if (s.radius) return "rounded";
  return "rect";
}

/** Change a rectangle / ellipse into another box preset, keeping its box, look and text. */
export function setBoxPreset(s: Shape, preset: BoxPreset) {
  s.kind = preset === "ellipse" ? "ellipse" : "rect";
  delete s.form;
  delete s.turn;
  delete s.flip;
  if (preset !== "rounded") delete s.radius;
  else s.radius ??= DEFAULT_RADIUS;
  if (isForm(preset)) s.form = preset;
  if (preset === "textbox") s.label ??= { text: "" };
}
