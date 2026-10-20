/**
 * Pages and what is drawn on them besides components and wires: adding, ordering and setting up
 * pages (border, title block, cover sheet, table of contents, terminal diagrams), free texts,
 * drawn shapes and pictures, and title block templates. Same rules as the editor; no server
 * dependencies (unit tested).
 */
import type { CoverSheet, Doc, FreeText, LineStyle, Page, Pt, Shape, ShapeLabel, TextRole, TextStyle, TitleBlockLogo, TitleBlockTemplate } from "@/core/model";
import { boxPresetOf, boxShape, isBoxPreset, pathShape, setBoxPreset, shapeName, type BoxPreset, type ShapePreset } from "@/core/shape-presets";
import { connectorBetween, isOpenPath } from "@/core/shape-geom";
import { TEXT_ROLES } from "@/core/model";
import { newPage } from "@/core/doc";
import { getPage, deleteSelection, mkSel, moveSelection } from "@/core/ops";
import { duplicatePage, movePageTo } from "@/core/pages";
import { newCover, coverFromPageTexts } from "@/core/render/cover";
import { insertTerminalDiagram } from "@/core/render/terminal-diagram";
import { collectStrips } from "@/core/terminals";
import { gridRef } from "@/core/xref";
import { uid } from "@/core/ids";
import { logoSize } from "@/core/logos";
import { addField, deleteCol, deleteRow, insertCol, insertRow, mergeCells, parseColSpec, removeCell, resizeRow, spanCell, updateCell, templateVariables } from "@/core/titleblock-edit";
import { AddressError, findPage, positionOf, sheetNo, sheets, short } from "./doc";
import { EditError } from "./edits";

type Kind = NonNullable<Page["kind"]>;
const KIND_NAME: Record<Kind, string> = { drawing: "drawing", cover: "cover sheet", contents: "table of contents", terminals: "terminal diagram" };

/* ------------------------------------------------------------------ */
/* Pages                                                                */
/* ------------------------------------------------------------------ */

/**
 * Add a page: a drawing sheet (border and title block like the page before it), a cover sheet
 * (first), a table of contents (after the cover), terminal diagram sheets for strips, or a copy
 * of a page.
 */
export function addPage(doc: Doc, o: { kind?: Kind; title?: string; after?: string; duplicate?: string; strips?: string[] }): { text: string; pageIds: string[] } {
  const list = sheets(doc);
  if (o.duplicate) {
    const src = findPage(doc, o.duplicate);
    const id = duplicatePage(doc, src.id);
    const p = getPage(doc, id);
    if (o.title?.trim()) p.title = o.title.trim();
    if (o.after) movePageTo(doc, id, sheetNo(doc, findPage(doc, o.after)) + 1);
    return { text: `Copied page ${sheetNo(doc, src)} "${src.title}" as page ${sheetNo(doc, p)} "${p.title}" (${p.elements.length} components, ${p.wires.length} wires — references are the same as on the original; renumber if needed)`, pageIds: [id] };
  }
  const kind = o.kind ?? "drawing";
  const after = o.after ? findPage(doc, o.after) : list[list.length - 1];
  if (kind === "terminals") {
    const all = collectStrips(doc).map((v) => v.tag).filter(Boolean);
    const tags = o.strips?.length ? o.strips : all;
    if (!tags.length) throw new EditError("No terminal strips yet — give terminals references like X1:1, or create a strip with edit_terminal_strip");
    for (const t of tags) if (!all.includes(t)) throw new EditError(`No terminal strip ${t} (strips: ${all.join(", ") || "none"})`);
    let at = after?.id;
    const ids: string[] = [];
    for (const t of tags) {
      const made = insertTerminalDiagram(doc, t, { afterPageId: at, newPage });
      ids.push(...made);
      at = made[made.length - 1] ?? at;
    }
    return { text: `Added ${ids.length} terminal diagram sheet${ids.length === 1 ? "" : "s"} for ${tags.join(", ")}: pages ${ids.map((id) => sheetNo(doc, getPage(doc, id))).join(", ")} (generated from the schematic, they stay up to date)`, pageIds: ids };
  }
  const title = o.title?.trim() || (kind === "cover" ? "Cover sheet" : kind === "contents" ? "Table of contents" : `Page ${list.length + 1}`);
  const p = newPage(0, title);
  if (kind !== "drawing") p.kind = kind;
  if (kind === "cover") p.cover = newCover();
  const ref = after ?? list[0];
  if (ref) {
    p.border = { ...ref.border };
    p.titleBlock = { ...ref.titleBlock, fields: { ...ref.titleBlock.fields, title } };
  }
  if (!doc.titleBlocks[p.titleBlock.template] && Object.keys(doc.titleBlocks).length) p.titleBlock.template = Object.keys(doc.titleBlocks)[0];
  const sorted = [...list];
  const at = kind === "cover" && !o.after ? 0 : kind === "contents" && !o.after ? Math.max(0, sorted.findIndex((x) => x.kind !== "cover")) : after ? sorted.indexOf(after) + 1 : sorted.length;
  sorted.splice(at < 0 ? sorted.length : at, 0, p);
  doc.pages.push(p);
  const archived = doc.pages.filter((x) => x.archived);
  [...sorted, ...archived].forEach((x, i) => (getPage(doc, x.id).order = i));
  return { text: `Added ${KIND_NAME[kind]} "${title}" as page ${sheetNo(doc, getPage(doc, p.id))} (id ${p.id})`, pageIds: [p.id] };
}

export type PagePatch = {
  title?: string;
  /** new position among the pages (1 = first) */
  position?: number;
  kind?: Kind;
  border?: { show?: boolean; columns?: number; rows?: number; column_width?: number; row_height?: number; show_column_numbers?: boolean; show_row_letters?: boolean };
  titleBlock?: { show?: boolean; template?: string; fields?: Record<string, string>; allPages?: boolean };
  archived?: boolean;
  terminalDiagram?: { strip?: string; from?: number | null; to?: number | null; style?: "rail" | "box" };
};

/** Rename, move, change type, border, title block or archive a page. */
export function updatePage(doc: Doc, pageRef: string, x: PagePatch): string {
  const p = getPage(doc, findPageAny(doc, pageRef).id);
  const done: string[] = [];
  if (x.title !== undefined) {
    const t = x.title.trim();
    if (!t) throw new EditError("A page needs a name");
    // the title block shows the page name unless it was typed differently
    if (!p.titleBlock.fields.title || p.titleBlock.fields.title === p.title) p.titleBlock.fields.title = t;
    done.push(`renamed "${p.title}" → "${t}"`);
    p.title = t;
  }
  if (x.archived !== undefined) {
    if (x.archived && sheets(doc).length < 2) throw new EditError("The last page cannot be archived");
    p.archived = x.archived || undefined;
    done.push(x.archived ? "archived (hidden from the drawing set; restore with archived: false)" : "restored");
  }
  if (x.kind !== undefined) {
    if (x.kind === "cover" && !p.cover) {
      const { cover, used } = coverFromPageTexts(p);
      const took = cover.fields.length && used.length ? used : [];
      p.cover = took.length ? cover : newCover();
      if (took.length) p.texts = p.texts.filter((t) => !took.includes(t.id));
      if (took.length) done.push(`cover sheet made from the typed text (${cover.fields.length} fields)`);
    }
    if (x.kind === "drawing") delete p.kind;
    else p.kind = x.kind;
    if (x.kind === "terminals" && !p.terminalDiagram) p.terminalDiagram = { tag: collectStrips(doc).find((v) => v.tag)?.tag ?? "" };
    done.push(`type ${KIND_NAME[x.kind]}`);
  }
  if (x.terminalDiagram) {
    if ((p.kind ?? "drawing") !== "terminals") throw new EditError("This page is not a terminal diagram (set kind: terminals first)");
    const td = { ...(p.terminalDiagram ?? { tag: "" }) };
    if (x.terminalDiagram.strip !== undefined) {
      const tags = collectStrips(doc).map((v) => v.tag).filter(Boolean);
      if (!tags.includes(x.terminalDiagram.strip)) throw new EditError(`No strip ${x.terminalDiagram.strip} (strips: ${tags.join(", ") || "none"})`);
      td.tag = x.terminalDiagram.strip;
    }
    if (x.terminalDiagram.from !== undefined) td.from = x.terminalDiagram.from ?? undefined;
    if (x.terminalDiagram.to !== undefined) td.to = x.terminalDiagram.to ?? undefined;
    if (x.terminalDiagram.style) td.style = x.terminalDiagram.style;
    p.terminalDiagram = td;
    done.push(`terminal diagram of ${td.tag}${td.from ? ` from terminal ${td.from}` : ""}${td.to ? ` to ${td.to}` : ""}`);
  }
  if (x.border) {
    const b = { ...p.border };
    const num = (v: number | undefined, lo: number, hi: number, name: string) => {
      if (v === undefined) return undefined;
      if (!(v >= lo && v <= hi)) throw new EditError(`${name} must be ${lo}–${hi}`);
      return Math.round(v);
    };
    b.cols = num(x.border.columns, 1, 60, "columns") ?? b.cols;
    b.rows = num(x.border.rows, 1, 40, "rows") ?? b.rows;
    b.colW = num(x.border.column_width, 10, 400, "column_width") ?? b.colW;
    b.rowH = num(x.border.row_height, 10, 400, "row_height") ?? b.rowH;
    if (x.border.show !== undefined) b.show = x.border.show;
    if (x.border.show_column_numbers !== undefined) b.showCols = x.border.show_column_numbers;
    if (x.border.show_row_letters !== undefined) b.showRows = x.border.show_row_letters;
    p.border = b;
    done.push(`border ${b.show ? `${b.cols} × ${b.rows} cells of ${b.colW} × ${b.rowH}` : "hidden"}`);
  }
  if (x.titleBlock) {
    const tb = x.titleBlock;
    if (tb.show !== undefined) ((p.titleBlock.show = tb.show), done.push(`title block ${tb.show ? "shown" : "hidden"}`));
    if (tb.template !== undefined) {
      if (!doc.titleBlocks[tb.template]) throw new EditError(`No title block template "${tb.template}" in this project (templates: ${Object.keys(doc.titleBlocks).join(", ")})`);
      const targets = tb.allPages ? doc.pages : [p];
      for (const q of targets) q.titleBlock.template = tb.template;
      done.push(`title block template "${tb.template}"${tb.allPages ? " on every page" : ""}`);
    }
    if (tb.fields) {
      const targets = tb.allPages ? doc.pages : [p];
      for (const q of targets)
        for (const [k0, v] of Object.entries(tb.fields)) {
          const k = k0.replace(/^%/, "");
          const key = q.titleBlock.fields["custom:" + k] !== undefined ? "custom:" + k : k;
          q.titleBlock.fields[key] = v;
        }
      done.push(`title block ${Object.entries(tb.fields).map(([k, v]) => `${k}=${v || "(empty)"}`).join("; ")}${tb.allPages ? " on every page" : ""}`);
      const tpl = doc.titleBlocks[p.titleBlock.template];
      const shown = tpl ? templateVariables(tpl) : null;
      const unused = shown ? Object.keys(tb.fields).filter((k) => !shown.has(k.replace(/^%/, ""))) : [];
      if (unused.length) done.push(`note: the template does not show ${unused.join(", ")}`);
    }
  }
  if (x.position !== undefined) {
    const n = sheets(doc).length;
    if (!(x.position >= 1 && x.position <= n)) throw new EditError(`position must be 1–${n}`);
    movePageTo(doc, p.id, x.position);
    done.push(`moved to position ${x.position}`);
  }
  if (!done.length) throw new EditError("Nothing to change");
  return `Page ${p.archived ? "(archived)" : sheetNo(doc, p)} "${p.title}": ${done.join("; ")}`;
}

/** archived pages are addressed by title or id too */
function findPageAny(doc: Doc, ref: string): Page {
  try {
    return findPage(doc, ref);
  } catch (e) {
    const s = ref.trim().toLowerCase();
    const hit = doc.pages.find((p) => p.archived && (p.id === ref.trim() || p.title.trim().toLowerCase() === s));
    if (hit) return hit;
    throw e;
  }
}

export function deletePage(doc: Doc, pageRef: string): string {
  const p = findPageAny(doc, pageRef);
  if (doc.pages.length < 2) throw new EditError("The last page cannot be deleted");
  const n = p.elements.length, w = p.wires.length;
  const ids = new Set(p.elements.map((e) => e.id));
  // mates and arrow links pointing at what goes away
  for (const q of doc.pages)
    for (const e of q.elements) {
      if (e.mate && ids.has(e.mate.id) && !ids.has(e.id)) delete e.mate;
      if (e.links?.some((l) => ids.has(l))) {
        e.links = e.links.filter((l) => !ids.has(l));
        if (!e.links.length) delete e.links;
      }
    }
  const no = p.archived ? "archived" : String(sheetNo(doc, p));
  doc.pages = doc.pages.filter((q) => q.id !== p.id);
  sheets(doc).forEach((q, i) => (q.order = i));
  return `Deleted page ${no} "${p.title}" with ${n} component${n === 1 ? "" : "s"} and ${w} wire${w === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* Cover sheet and revision history                                     */
/* ------------------------------------------------------------------ */

export type CoverPatch = {
  title?: string;
  subtitle?: string;
  /** replace all data rows */
  fields?: { label: string; value: string }[];
  /** set rows by label (added when missing; empty value + remove removes) */
  setFields?: { label: string; value: string; remove?: boolean }[];
  manufacturer?: string;
  notes?: string;
  notice?: string;
  showRevisions?: boolean;
  logo?: (TitleBlockLogo & { name?: string }) | null | "organization";
  image?: (TitleBlockLogo & { name?: string }) | null;
};

export function setCover(doc: Doc, pageRef: string | undefined, c: CoverPatch): string {
  const p = pageRef ? findPage(doc, pageRef) : sheets(doc).find((x) => x.kind === "cover");
  if (!p) throw new EditError("The drawing has no cover sheet — add one with add_page kind: cover");
  if (p.kind !== "cover") throw new EditError(`Page ${sheetNo(doc, p)} is not a cover sheet`);
  const pg = getPage(doc, p.id);
  const cv: CoverSheet = pg.cover ?? newCover();
  const done: string[] = [];
  for (const k of ["title", "subtitle", "manufacturer", "notes", "notice"] as const) {
    const v = c[k];
    if (v === undefined) continue;
    cv[k] = v;
    done.push(`${k}${v ? "" : " cleared"}`);
  }
  if (c.fields) ((cv.fields = c.fields.map((f) => ({ label: f.label, value: f.value }))), done.push(`${c.fields.length} data rows`));
  for (const f of c.setFields ?? []) {
    const i = cv.fields.findIndex((x) => x.label.trim().toLowerCase() === f.label.trim().toLowerCase());
    if (f.remove) {
      if (i >= 0) cv.fields.splice(i, 1);
    } else if (i >= 0) cv.fields[i] = { label: cv.fields[i].label, value: f.value };
    else cv.fields.push({ label: f.label, value: f.value });
    done.push(f.remove ? `removed ${f.label}` : `${f.label}=${f.value || "(empty)"}`);
  }
  if (c.showRevisions !== undefined) ((cv.showRevisions = c.showRevisions), done.push(`revision table ${c.showRevisions ? "shown" : "hidden"}`));
  if (c.logo !== undefined) {
    if (c.logo === "organization") delete cv.logo;
    else cv.logo = c.logo;
    done.push(c.logo === "organization" ? "organization logo" : c.logo ? "logo set" : "no logo");
  }
  if (c.image !== undefined) {
    if (c.image) cv.image = c.image;
    else delete cv.image;
    done.push(c.image ? "product picture set" : "product picture removed");
  }
  pg.cover = cv;
  if (!done.length) throw new EditError("Nothing to change");
  return `Cover sheet (page ${sheetNo(doc, p)}): ${done.join("; ")}`;
}

/* ------------------------------------------------------------------ */
/* Free texts, shapes, pictures                                          */
/* ------------------------------------------------------------------ */

const ROLE_ALIAS: Record<string, TextRole> = { note: "annotation", annotation: "annotation", title: "pageTitle", heading: "pageTitle" };
function roleOf(r?: string): TextRole {
  if (!r) return "annotation";
  const k = ROLE_ALIAS[r] ?? (TEXT_ROLES as readonly string[]).find((x) => x.toLowerCase() === r.toLowerCase());
  if (!k) throw new EditError(`role must be one of ${TEXT_ROLES.join(", ")}`);
  return k as TextRole;
}

export type TextPatch = {
  text?: string;
  role?: string;
  size?: number;
  colour?: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  rotation?: number;
  font?: string;
  /** formatted text box: wrap width, alignment, border and background; null = plain text */
  box?: { width?: number; align?: "left" | "center" | "right" | "justify"; border?: { colour: string; width: number } | null; background?: string | null; padding?: number } | null;
};

function styleText(t: FreeText, x: TextPatch) {
  if (x.text !== undefined) t.text = x.text;
  if (x.role !== undefined) t.role = roleOf(x.role);
  const o: Partial<TextStyle> = { ...(t.override ?? {}) };
  if (x.size !== undefined) o.size = x.size;
  if (x.colour !== undefined) o.color = x.colour;
  if (x.bold !== undefined) o.weight = x.bold ? 700 : 400;
  if (x.italic !== undefined) o.italic = x.italic;
  if (x.align !== undefined) o.align = x.align;
  if (x.rotation !== undefined) o.rotation = x.rotation;
  if (x.font !== undefined) o.font = x.font;
  if (Object.keys(o).length) t.override = o;
  if (x.box !== undefined) {
    if (x.box === null) delete t.rich;
    else
      t.rich = {
        ...(t.rich ?? {}),
        ...(x.box.width !== undefined ? { width: x.box.width } : {}),
        ...(x.box.align ? { align: x.box.align } : {}),
        ...(x.box.border !== undefined ? { border: x.box.border ? { color: x.box.border.colour, width: x.box.border.width } : null } : {}),
        ...(x.box.background !== undefined ? { background: x.box.background } : {}),
        ...(x.box.padding !== undefined ? { padding: x.box.padding } : {}),
      };
  }
}

/** Put a text on a page (notes, headings, formatted boxes with **bold** and bullet lists). */
export function addText(doc: Doc, pageRef: string, at: { cell?: string; x?: number; y?: number }, x: TextPatch): string {
  const p = getPage(doc, findPage(doc, pageRef).id);
  if (!x.text?.trim()) throw new EditError("The text is empty");
  const pos = positionOf(doc, p, at);
  const t: FreeText = { id: uid(), x: pos.x, y: pos.y, text: "", role: "annotation" };
  styleText(t, x);
  p.texts.push(t);
  return `Text ${short(t.id)} on page ${sheetNo(doc, p)} at ${gridRef(doc, p, pos) || `(${pos.x}, ${pos.y})`}: "${t.text.slice(0, 60)}${t.text.length > 60 ? "…" : ""}"`;
}

export type ShapePatch = {
  colour?: string;
  width?: number;
  dash?: LineStyle["dash"];
  fill?: string | null;
  closed?: boolean;
  points?: Pt[];
  picture?: (TitleBlockLogo & { name?: string }) | null;
  /** text inside the shape / on the line ("" removes it) */
  label?: string;
  labelStyle?: { size?: number | null; colour?: string | null; bold?: boolean; italic?: boolean; align?: ShapeLabel["align"]; valign?: ShapeLabel["valign"] };
  arrows?: "start" | "end" | "both" | "none";
  /** box shapes: switch the outline (rect, rounded, ellipse, diamond …) */
  outline?: BoxPreset;
  radius?: number;
};

export type AddShapeKind = ShapePreset | "picture";

/** text and arrows of a shape, from a patch */
function applyLabelAndArrows(s: Shape, x: ShapePatch) {
  if (x.label !== undefined) {
    const text = x.label.replace(/\s+$/, "");
    if (text) s.label = { ...(s.label ?? {}), text };
    else if (s.label) {
      if (isOpenPath(s)) delete s.label;
      else s.label.text = "";
    }
  }
  if (x.labelStyle) {
    const st = x.labelStyle;
    const l: ShapeLabel = { text: "", ...(s.label ?? {}) };
    if (st.size !== undefined) l.size = st.size ?? undefined;
    if (st.colour !== undefined) l.color = st.colour ?? undefined;
    if (st.bold !== undefined) l.bold = st.bold || undefined;
    if (st.italic !== undefined) l.italic = st.italic || undefined;
    if (st.align !== undefined) l.align = st.align === "center" ? undefined : st.align;
    if (st.valign !== undefined) l.valign = st.valign === "middle" ? undefined : st.valign;
    for (const k of Object.keys(l) as (keyof ShapeLabel)[]) if (l[k] === undefined) delete l[k];
    s.label = l;
  }
  if (x.arrows !== undefined) {
    if (!isOpenPath(s)) throw new EditError("Arrow heads go on lines and open polylines");
    if (x.arrows === "none") delete s.arrows;
    else s.arrows = { ...(x.arrows !== "end" ? { start: true } : {}), ...(x.arrows !== "start" ? { end: true } : {}) };
  }
}

/**
 * Draw a shape — a box (rectangle, text box, rounded box, ellipse, diamond, hexagon, triangle,
 * parallelogram, cylinder, document) from two corners, a line / arrow / polyline / polygon through
 * points — or place a picture in a rectangle; optionally with text inside / on it.
 */
export function addShape(doc: Doc, pageRef: string, kind: AddShapeKind, pts: Pt[], x: ShapePatch): string {
  const p = getPage(doc, findPage(doc, pageRef).id);
  const box = kind === "picture" || isBoxPreset(kind);
  if (pts.length < 2) throw new EditError(box ? "Give two opposite corners" : "Give at least two points");
  if ((box || kind === "line") && pts.length !== 2) throw new EditError(`A ${kind} takes exactly two points`);
  if (kind === "polygon" && pts.length < 3) throw new EditError("A polygon takes at least three points");
  let points = pts;
  if (kind === "picture") {
    if (!x.picture) throw new EditError("Give the picture (base64 PNG, JPG or SVG)");
    // keep the picture's aspect ratio inside the box width
    const n = logoSize(x.picture);
    const [a, c] = pts;
    const w = Math.abs(c.x - a.x);
    if (n && w) points = [{ x: Math.min(a.x, c.x), y: Math.min(a.y, c.y) }, { x: Math.min(a.x, c.x) + w, y: Math.min(a.y, c.y) + Math.round((w * n.h) / n.w) }];
  }
  const [a, c] = points;
  if (box && (Math.abs(a.x - c.x) < 1 || Math.abs(a.y - c.y) < 1)) throw new EditError("The two corners must differ in x and in y");
  const look = { color: x.colour ?? "#111827", width: x.width ?? (kind === "picture" ? 0 : 1), dash: x.dash ?? ("solid" as const), fill: x.fill ?? null };
  const sh: Shape = kind === "picture" ? boxShape(uid(), "rect", a, c, look) : isBoxPreset(kind) ? boxShape(uid(), kind, a, c, look) : pathShape(uid(), kind, points, look);
  if (kind === "polygon" && x.closed === false) ((sh.closed = false), (sh.fill = null));
  if (kind === "picture" && x.picture) sh.image = x.picture;
  if (x.radius !== undefined && sh.kind === "rect" && !sh.form) sh.radius = x.radius || undefined;
  if (sh.width === 0 && !sh.label && !sh.image && !x.label) throw new EditError("width 0 (no outline) is for text boxes and pictures — give text, or a width");
  applyLabelAndArrows(sh, x);
  p.shapes.push(sh);
  const where = gridRef(doc, p, points[0]) || `(${points[0].x}, ${points[0].y})`;
  return `${shapeName(sh)} ${short(sh.id)} on page ${sheetNo(doc, p)} at ${where}${sh.label?.text ? ` with "${sh.label.text.replace(/\s+/g, " ").slice(0, 60)}"` : ""}`;
}

/** An arrow (or line) from one shape to another: side to side, straight or with one bend. */
export function connectShapes(doc: Doc, fromRef: string, toRef: string, x: ShapePatch & { kind?: "arrow" | "line" }): string {
  const A = findItem(doc, fromRef), B = findItem(doc, toRef);
  if (A.kind !== "shape" || B.kind !== "shape") throw new EditError("from_item and to_item are shapes (ids from list_page_items)");
  if (A.page.id !== B.page.id) throw new EditError("The two shapes are on different pages");
  const pts = connectorBetween(A.s, B.s, doc.grid?.size || 10);
  return addShape(doc, A.page.id, x.kind ?? "arrow", pts, { ...x, arrows: x.arrows ?? (x.kind === "line" ? undefined : "end") });
}

type Item = { kind: "text"; page: Page; t: FreeText } | { kind: "shape"; page: Page; s: Shape } | { kind: "junction"; page: Page; id: string };
/** a free text, shape or junction by id ("#1a2b3c4d") */
export function findItem(doc: Doc, ref: string): Item {
  const k = ref.trim().replace(/^#/, "").replace(/-/g, "").toLowerCase();
  if (k.length < 6) throw new AddressError(`"${ref}": give at least 6 characters of the id (list_page_items)`);
  const hits: Item[] = [];
  for (const page of doc.pages) {
    for (const t of page.texts) if (t.id.replace(/-/g, "").toLowerCase().startsWith(k)) hits.push({ kind: "text", page, t });
    for (const s of page.shapes) if (s.id.replace(/-/g, "").toLowerCase().startsWith(k)) hits.push({ kind: "shape", page, s });
    for (const j of page.junctions) if (j.id.replace(/-/g, "").toLowerCase().startsWith(k)) hits.push({ kind: "junction", page, id: j.id });
  }
  if (hits.length === 1) return hits[0];
  throw new AddressError(hits.length ? `"${ref}" matches ${hits.length} items — give more characters` : `No text, shape or junction ${ref} — list_page_items shows them (components and wires have their own tools)`);
}

/** Change a free text or a drawn shape / picture: content, style, position. */
export function updateItem(doc: Doc, ref: string, x: TextPatch & ShapePatch & { at?: { cell?: string; x?: number; y?: number }; dx?: number; dy?: number }): string {
  const it = findItem(doc, ref);
  const pg = getPage(doc, it.page.id);
  if (it.kind === "junction") throw new EditError("A junction has nothing to change (delete_items removes it)");
  const done: string[] = [];
  if (it.kind === "text") {
    const t = pg.texts.find((q) => q.id === it.t.id)!;
    styleText(t, x);
    if (x.at) {
      const p = positionOf(doc, pg, x.at);
      ((t.x = p.x), (t.y = p.y));
    }
    if (x.dx || x.dy) moveSelection(doc, pg, mkSel({ texts: [t.id] }), { x: x.dx ?? 0, y: x.dy ?? 0 });
    done.push(`text "${t.text.slice(0, 40)}"`);
  } else {
    const s = pg.shapes.find((q) => q.id === it.s.id)!;
    if (x.outline !== undefined) {
      if (boxPresetOf(s) === null) throw new EditError("Only boxes (rectangles, ellipses and their outlines) switch outline");
      setBoxPreset(s, x.outline);
    }
    if (x.radius !== undefined) {
      if (s.kind !== "rect" || s.form) throw new EditError("Corner radius is for rectangles");
      if (x.radius > 0) s.radius = x.radius;
      else delete s.radius;
    }
    if (x.width === 0 && !s.label && !s.image && !x.label) throw new EditError("width 0 (no outline) is for text boxes and pictures");
    // size / bold / italic / align given like a free text's: they are the shape text's
    const ls = x.labelStyle ?? (x.size !== undefined || x.bold !== undefined || x.italic !== undefined || x.align !== undefined ? { size: x.size, bold: x.bold, italic: x.italic, align: x.align } : undefined);
    applyLabelAndArrows(s, { ...x, labelStyle: ls });
    if (x.colour !== undefined) s.color = x.colour;
    if (x.width !== undefined) s.width = x.width;
    if (x.dash !== undefined) s.dash = x.dash;
    if (x.fill !== undefined) s.fill = s.kind === "line" ? null : x.fill;
    if (x.closed !== undefined && s.kind === "polygon") s.closed = x.closed;
    if (x.points) {
      if (x.points.length < 2) throw new EditError("Give at least two points");
      s.pts = x.points;
    }
    if (x.picture !== undefined) {
      if (s.kind !== "rect") throw new EditError("Pictures sit in rectangles");
      if (x.picture) s.image = x.picture;
      else delete s.image;
    }
    if (x.at) {
      const p = positionOf(doc, pg, x.at);
      moveSelection(doc, pg, mkSel({ shapes: [s.id] }), { x: p.x - s.pts[0].x, y: p.y - s.pts[0].y });
    }
    if (x.dx || x.dy) moveSelection(doc, pg, mkSel({ shapes: [s.id] }), { x: x.dx ?? 0, y: x.dy ?? 0 });
    done.push(shapeName(s).toLowerCase());
  }
  return `Changed ${done.join(", ")} ${short(ref.replace(/^#/, ""))} on page ${sheetNo(doc, pg)}`;
}

/** Delete free texts, drawn shapes / pictures and junctions (wires at a deleted junction get free ends). */
export function deleteItems(doc: Doc, refs: string[]): string {
  const byPage = new Map<string, { texts: string[]; shapes: string[]; junctions: string[] }>();
  for (const r of refs) {
    const it = findItem(doc, r);
    const b = byPage.get(it.page.id) ?? { texts: [], shapes: [], junctions: [] };
    if (it.kind === "text") b.texts.push(it.t.id);
    else if (it.kind === "shape") b.shapes.push(it.s.id);
    else b.junctions.push(it.id);
    byPage.set(it.page.id, b);
  }
  let t = 0, s = 0, j = 0;
  for (const [pid, b] of byPage) {
    deleteSelection(doc, getPage(doc, pid), mkSel(b));
    ((t += b.texts.length), (s += b.shapes.length), (j += b.junctions.length));
  }
  return `Deleted ${[t && `${t} text${t === 1 ? "" : "s"}`, s && `${s} shape${s === 1 ? "" : "s"}`, j && `${j} junction${j === 1 ? "" : "s"}`].filter(Boolean).join(", ")}`;
}

/** what a page carries besides components and wires */
export function pageItemsText(doc: Doc, pageRef: string): string {
  const p = findPage(doc, pageRef);
  const at = (q: Pt) => gridRef(doc, p, q) || `(${Math.round(q.x)}, ${Math.round(q.y)})`;
  const lines = [`Page ${sheetNo(doc, p)} "${p.title}"${p.kind && p.kind !== "drawing" ? ` (${KIND_NAME[p.kind]})` : ""} — border ${p.border.show ? `${p.border.cols} × ${p.border.rows} cells of ${p.border.colW} × ${p.border.rowH}` : "hidden"}; title block "${p.titleBlock.template}"${p.titleBlock.show ? "" : " (hidden)"}`];
  const fields = Object.entries(p.titleBlock.fields).filter(([, v]) => v);
  if (fields.length) lines.push(`Title block fields: ${fields.map(([k, v]) => `${k.replace(/^custom:/, "")}=${v}`).join("; ")}`);
  if (p.kind === "cover" && p.cover) {
    const c = p.cover;
    lines.push(`Cover: title "${c.title ?? ""}", subtitle "${c.subtitle ?? ""}"; ${c.fields.map((f) => `${f.label}=${f.value || "—"}`).join("; ")}; manufacturer ${c.manufacturer ? `"${c.manufacturer.replace(/\n/g, ", ")}"` : "—"}; logo ${c.logo === null ? "none" : c.logo ? "own" : "organization"}; picture ${c.image ? c.image.name ?? "yes" : "none"}; revision table ${c.showRevisions === false ? "hidden" : "shown"}`);
  }
  if (p.kind === "terminals" && p.terminalDiagram) lines.push(`Terminal diagram of strip ${p.terminalDiagram.tag || "?"}${p.terminalDiagram.from ? ` from terminal ${p.terminalDiagram.from}` : ""}${p.terminalDiagram.to ? ` to ${p.terminalDiagram.to}` : ""} (${p.terminalDiagram.style ?? "rail"})`);
  lines.push("", `Texts (${p.texts.length}) — id | at | role | text`);
  for (const t of p.texts) lines.push(`${short(t.id)} | ${at(t)} | ${t.role}${t.rich ? " box" : ""} | ${t.text.replace(/\s+/g, " ").slice(0, 100)}`);
  lines.push("", `Shapes and pictures (${p.shapes.length}) — id | kind | from → to (x,y) | style | text`);
  const xy = (q: Pt) => `${Math.round(q.x)},${Math.round(q.y)}`;
  for (const s of p.shapes) {
    const kind = s.image ? `picture ${s.image.name ?? s.image.type}` : `${shapeName(s).toLowerCase()}${s.arrows ? ` (arrow ${s.arrows.start && s.arrows.end ? "both ends" : s.arrows.start ? "at start" : "at end"})` : ""}${s.radius && !s.form ? ` r${s.radius}` : ""}`;
    const style = `${s.color} ${s.width}${s.dash !== "solid" ? " " + s.dash : ""}${s.fill ? ` fill ${s.fill}` : ""}`;
    const l = s.label;
    const text = l?.text ? `"${l.text.replace(/\s+/g, " ").slice(0, 80)}"${l.size ? ` ${l.size}pt` : ""}${l.bold ? " bold" : ""}${l.italic ? " italic" : ""}${l.align ? ` ${l.align}` : ""}${l.valign ? ` ${l.valign}` : ""}` : "-";
    lines.push(`${short(s.id)} | ${kind} | ${at(s.pts[0])} → ${at(s.pts[s.pts.length - 1])} (${xy(s.pts[0])} → ${xy(s.pts[s.pts.length - 1])})${s.pts.length > 2 ? ` ${s.pts.length} points` : ""} | ${style} | ${text}`);
  }
  const deg = (id: string) => p.wires.filter((w) => (w.a.k === "junction" && w.a.j === id) || (w.b.k === "junction" && w.b.j === id)).length;
  lines.push("", `Junctions (${p.junctions.length}) — id | at | x, y | wires`);
  for (const j of p.junctions) lines.push(`${short(j.id)} | ${at(j)} | ${j.x}, ${j.y} | ${deg(j.id)}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Title block templates                                                */
/* ------------------------------------------------------------------ */

export type TbOp =
  | { op: "set_cell"; row: number; col: number; value?: string; label?: string; show_label?: boolean; align?: "left" | "center" | "right"; size?: number; name?: string }
  | { op: "add_field"; row: number; col: number; value?: string; label?: string; name?: string; show_label?: boolean }
  | { op: "remove_cell"; row: number; col: number }
  | { op: "span_cell"; row: number; col: number; rowspan: number; colspan: number }
  | { op: "merge_cells"; cells: { row: number; col: number }[] }
  | { op: "insert_row"; at: number; height?: number }
  | { op: "delete_row"; at: number }
  | { op: "resize_row"; at: number; height: number }
  | { op: "insert_col"; at: number; width?: string }
  | { op: "delete_col"; at: number }
  | { op: "set_col"; at: number; width: string };

/**
 * Edit a title block template of the project (the grid of fields drawn on every page that uses
 * it): cell values (%title, %author, project properties …) and labels, add / remove / merge cells,
 * rows and columns. Rows and columns count from 0. Column widths: "50" (units), "t22" (fixed
 * title-block width), "r100" (share of the rest).
 */
export function editTitleBlock(doc: Doc, name: string, ops: TbOp[], o: { copyAs?: string } = {}): string {
  const src = doc.titleBlocks[name];
  if (!src) throw new EditError(`No title block template "${name}" (templates: ${Object.keys(doc.titleBlocks).join(", ")})`);
  let t: TitleBlockTemplate = JSON.parse(JSON.stringify(src));
  const at = (row: number, col: number) => {
    const i = t.cells.findIndex((c) => row >= c.row && row <= c.row + c.rowspan && col >= c.col && col <= c.col + c.colspan);
    if (i < 0) throw new EditError(`No cell at row ${row}, column ${col} (the template has ${t.rows.length} rows and ${t.cols.length} columns)`);
    return i;
  };
  const done: string[] = [];
  for (const x of ops) {
    switch (x.op) {
      case "set_cell": {
        const i = at(x.row, x.col);
        t = updateCell(t, i, { ...(x.value !== undefined ? { value: x.value, type: "field" as const } : {}), ...(x.label !== undefined ? { label: x.label } : {}), ...(x.show_label !== undefined ? { showLabel: x.show_label } : {}), ...(x.align ? { align: x.align } : {}), ...(x.size ? { size: x.size } : {}), ...(x.name ? { name: x.name } : {}) });
        done.push(`cell ${x.row},${x.col}`);
        break;
      }
      case "add_field": {
        const r = addField(t, x.row, x.col, { value: x.value ?? "", label: x.label ?? "", name: x.name, showLabel: x.show_label ?? !!x.label });
        t = r.t;
        done.push(`field at ${x.row},${x.col}`);
        break;
      }
      case "remove_cell":
        t = removeCell(t, at(x.row, x.col));
        done.push(`removed cell ${x.row},${x.col}`);
        break;
      case "span_cell": {
        const r = spanCell(t, at(x.row, x.col), x.rowspan, x.colspan);
        if (!r) throw new EditError(`Cell ${x.row},${x.col} cannot span ${x.rowspan + 1} × ${x.colspan + 1} (cells in the way or outside)`);
        t = r;
        done.push(`cell ${x.row},${x.col} spans ${x.rowspan + 1} × ${x.colspan + 1}`);
        break;
      }
      case "merge_cells": {
        const r = mergeCells(t, x.cells.map((c) => at(c.row, c.col)));
        if (!r) throw new EditError("Those cells do not form a rectangle");
        t = r.t;
        done.push(`merged ${x.cells.length} cells`);
        break;
      }
      case "insert_row":
        t = insertRow(t, x.at, x.height ?? 25);
        done.push(`row inserted at ${x.at}`);
        break;
      case "delete_row": {
        const r = deleteRow(t, x.at);
        if (!r) throw new EditError("That row cannot be deleted (the last row, or a cell spans it)");
        t = r;
        done.push(`row ${x.at} deleted`);
        break;
      }
      case "resize_row":
        t = resizeRow(t, x.at, x.height);
        done.push(`row ${x.at} height ${x.height}`);
        break;
      case "insert_col": {
        const c = x.width ? parseColSpec(x.width) : { kind: "abs" as const, v: 50 };
        if (!c) throw new EditError(`Column width "${x.width}": write 50, t22 or r100`);
        t = insertCol(t, x.at, c);
        done.push(`column inserted at ${x.at}`);
        break;
      }
      case "delete_col": {
        const r = deleteCol(t, x.at);
        if (!r) throw new EditError("That column cannot be deleted (the last column, or a cell spans it)");
        t = r;
        done.push(`column ${x.at} deleted`);
        break;
      }
      case "set_col": {
        const c = parseColSpec(x.width);
        if (!c || !t.cols[x.at]) throw new EditError(!c ? `Column width "${x.width}": write 50, t22 or r100` : `No column ${x.at}`);
        t.cols[x.at] = c;
        done.push(`column ${x.at} width ${x.width}`);
        break;
      }
    }
  }
  delete t.layout; // edited: no longer the organization layout as approved
  const target = o.copyAs?.trim() || name;
  if (o.copyAs?.trim()) {
    if (doc.titleBlocks[target]) throw new EditError(`A template "${target}" exists already`);
    t.name = target;
  }
  doc.titleBlocks[target] = t;
  const users = doc.pages.filter((p) => p.titleBlock.template === target).length;
  return `Title block template "${target}"${o.copyAs ? ` (copy of "${name}")` : ""}: ${done.join(", ") || "saved"}; used by ${users} page${users === 1 ? "" : "s"}`;
}

/** a title block template as text (grid of cells) */
export function titleBlockText(t: TitleBlockTemplate): string {
  const col = (c: TitleBlockTemplate["cols"][number]) => (c.kind === "abs" ? String(c.v) : `${c.kind}${c.v}`);
  return [
    `Template "${t.name}"${t.layout ? ` (organization layout v${t.layout.version})` : ""}: ${t.rows.length} rows (heights ${t.rows.join(", ")}), ${t.cols.length} columns (widths ${t.cols.map(col).join(", ")})`,
    ...t.cells.map((c) => `  row ${c.row} col ${c.col}${c.rowspan || c.colspan ? ` span ${c.rowspan + 1}×${c.colspan + 1}` : ""}: ${c.type}${c.type === "field" ? ` ${c.label ? `"${c.label}"${c.showLabel ? "" : " (label hidden)"} ` : ""}= ${c.value || "(empty)"}` : c.type === "logo" ? ` ${c.value ?? ""}` : ""}`),
  ].join("\n");
}
