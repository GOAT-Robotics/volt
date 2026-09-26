/**
 * QElectroTech title block templates (<titleblocktemplate>) <-> Volt TitleBlockTemplate.
 *
 * Grid syntax (TitleBlockTemplate::parseRows / parseColumns in titleblocktemplate.cpp):
 *  - rows="25;25;"         absolute heights ("px" suffix allowed), ';'-separated, empty parts skipped
 *  - cols="t22%;r100%;90;"  "tN%" = N% of the total width, "rN%" = N% of the width remaining after
 *                           absolute and t-columns, "N" / "Npx" = absolute width
 * Cells: <field>/<logo> with row/col (0-based) and optional rowspan/colspan, which count the
 * *additional* rows/columns covered (TitleBlockCell::row_span, 0 = no span).
 * <field> texts are translated: <value>/<label> hold <translation lang="..">.
 */
import type { TitleBlockTemplate } from "../model";
import { stableStringify } from "../stable-json";
import { attr, bool, child, children, createEl, formatSubtree, int, optAttr, parseXml, serializeXml, textOf, type XDocument, type XElement } from "./xml";

type Cell = TitleBlockTemplate["cells"][number];

export class TitleBlockParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleBlockParseError";
  }
}

function translation(el: XElement | null, lang = "en"): string {
  const ts = children(el, "translation");
  if (!ts.length) return el ? textOf(el).trim() : "";
  const hit = ts.find((t) => attr(t, "lang") === lang) ?? ts.find((t) => attr(t, "lang") === "en") ?? ts[0];
  return textOf(hit);
}

export function parseRows(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(";")) {
    const m = /^([0-9]+)(?:px)?$/i.exec(part.trim());
    if (m) out.push(parseInt(m[1], 10));
  }
  return out;
}

export function parseCols(s: string): TitleBlockTemplate["cols"] {
  const out: TitleBlockTemplate["cols"] = [];
  for (const raw of s.split(";")) {
    const part = raw.trim();
    const abs = /^([0-9]+)(?:px)?$/i.exec(part);
    const rel = /^([rt])([0-9]+)%$/i.exec(part);
    if (abs) out.push({ kind: "abs", v: parseInt(abs[1], 10) });
    else if (rel) out.push({ kind: rel[1].toLowerCase() === "t" ? "t" : "r", v: parseInt(rel[2], 10) });
  }
  return out;
}

export const rowsToString = (rows: number[]) => rows.map((r) => `${Math.round(r)};`).join("");
export const colsToString = (cols: TitleBlockTemplate["cols"]) =>
  cols.map((c) => (c.kind === "abs" ? `${Math.round(c.v)};` : `${c.kind}${Math.round(c.v)}%;`)).join("");

/** Parse a <titleblocktemplate> element. Throws TitleBlockParseError when the grid is unusable. */
export function parseTitleBlockNode(el: XElement, lang = "en"): TitleBlockTemplate {
  if (el.tagName !== "titleblocktemplate") throw new TitleBlockParseError(`not a title block template: <${el.tagName}>`);
  const name = attr(el, "name");
  const grid = child(el, "grid");
  // TitleBlockTemplate::loadGrid(): both attributes are mandatory
  if (!grid || !grid.hasAttribute("rows") || !grid.hasAttribute("cols")) throw new TitleBlockParseError(`title block template "${name}" has no usable <grid>`);
  const rows = parseRows(attr(grid, "rows"));
  const cols = parseCols(attr(grid, "cols"));
  if (!rows.length || !cols.length) throw new TitleBlockParseError(`title block template "${name}" has an empty grid`);
  const cells: Cell[] = [];
  for (const c of children(grid)) {
    if (c.tagName !== "field" && c.tagName !== "logo") continue;
    const row = int(c, "row", -1);
    const col = int(c, "col", -1);
    // TitleBlockTemplate::checkCell(): cells outside the grid are ignored
    if (row < 0 || col < 0 || row >= rows.length || col >= cols.length) continue;
    const cell: Cell = {
      row,
      col,
      rowspan: Math.max(0, int(c, "rowspan", 0)),
      colspan: Math.max(0, int(c, "colspan", 0)),
      type: c.tagName === "logo" ? "logo" : "field",
    };
    const nm = optAttr(c, "name");
    if (nm) cell.name = nm;
    if (c.tagName === "logo") {
      const res = optAttr(c, "resource");
      if (res) cell.value = res;
    } else {
      cell.label = translation(child(c, "label"), lang);
      cell.value = translation(child(c, "value"), lang);
      cell.showLabel = bool(c, "displaylabel", true);
      const al = attr(c, "align", "left");
      cell.align = al === "center" ? "center" : al === "right" ? "right" : "left";
      const fs = int(c, "fontsize", 0);
      if (fs > 0) cell.size = fs;
    }
    cells.push(cell);
  }
  return { name, rows, cols, cells, xml: serializeXml(el) };
}

export function parseTitleBlockTemplate(xml: string, lang = "en"): TitleBlockTemplate {
  const root = parseXml(xml).documentElement;
  if (!root) throw new TitleBlockParseError("empty title block template");
  const t = parseTitleBlockNode(root, lang);
  t.xml = xml;
  return t;
}

const tbSignature = (t: TitleBlockTemplate) => stableStringify({ name: t.name, rows: t.rows, cols: t.cols, cells: t.cells });

function translationEl(doc: XDocument, tag: string, text: string | undefined): XElement {
  const el = doc.createElement(tag);
  if (text) el.appendChild(createEl(doc, "translation", { lang: "en" }, [text]));
  return el;
}

function buildGrid(doc: XDocument, t: TitleBlockTemplate, orig: XElement | null): XElement {
  const grid = doc.createElement("grid");
  if (orig) for (const a of ["rows", "cols"]) orig.removeAttribute(a);
  grid.setAttribute("rows", rowsToString(t.rows));
  grid.setAttribute("cols", colsToString(t.cols));
  const origCells = orig ? children(orig).filter((c) => c.tagName === "field" || c.tagName === "logo") : [];
  for (const c of t.cells) {
    if (c.type === "empty") continue;
    const tag = c.type === "logo" ? "logo" : "field";
    const prev = origCells.find((o) => o.tagName === tag && int(o, "row", -1) === c.row && int(o, "col", -1) === c.col);
    const el = prev ? (prev.cloneNode(true) as XElement) : doc.createElement(tag);
    el.setAttribute("name", c.name ?? "");
    el.setAttribute("row", String(c.row));
    el.setAttribute("col", String(c.col));
    if (c.rowspan) el.setAttribute("rowspan", String(c.rowspan));
    else el.removeAttribute("rowspan");
    if (c.colspan) el.setAttribute("colspan", String(c.colspan));
    else el.removeAttribute("colspan");
    if (tag === "logo") {
      el.setAttribute("resource", c.value ?? "");
    } else {
      el.setAttribute("displaylabel", c.showLabel === false ? "false" : "true");
      el.setAttribute("align", c.align ?? "left");
      if (!el.hasAttribute("valign")) el.setAttribute("valign", "center");
      if (!el.hasAttribute("hadjust")) el.setAttribute("hadjust", "true");
      el.setAttribute("fontsize", String(c.size ?? 9));
      const prevLabel = prev ? translation(child(prev, "label")) : undefined;
      const prevValue = prev ? translation(child(prev, "value")) : undefined;
      if (!prev || prevValue !== (c.value ?? "")) {
        const old = child(el, "value");
        if (old) el.removeChild(old);
        el.appendChild(translationEl(doc, "value", c.value));
      }
      if (!prev || prevLabel !== (c.label ?? "")) {
        const old = child(el, "label");
        if (old) el.removeChild(old);
        el.appendChild(translationEl(doc, "label", c.label));
      }
    }
    grid.appendChild(el);
  }
  return grid;
}

/**
 * Serialise a TitleBlockTemplate to a <titleblocktemplate> element string. The original xml is
 * returned untouched when the template was not modified; otherwise its <information>, <logos> and
 * any unknown nodes are kept and only <grid> is rebuilt.
 */
export function serializeTitleBlockTemplate(t: TitleBlockTemplate): string {
  if (t.xml) {
    try {
      const doc = parseXml(t.xml);
      const root = doc.documentElement as XElement;
      const orig = parseTitleBlockNode(root);
      if (tbSignature(orig) === tbSignature(t)) return t.xml;
      root.setAttribute("name", t.name);
      const oldGrid = child(root, "grid");
      const grid = buildGrid(doc, t, oldGrid ? (oldGrid.cloneNode(true) as XElement) : null);
      if (oldGrid) root.replaceChild(grid, oldGrid);
      else root.appendChild(grid);
      formatSubtree(doc, root, 0);
      return serializeXml(doc);
    } catch {
      /* fall through: regenerate */
    }
  }
  const doc = parseXml("<titleblocktemplate/>");
  const root = doc.documentElement as XElement;
  root.setAttribute("name", t.name);
  root.appendChild(doc.createElement("information"));
  root.appendChild(doc.createElement("logos"));
  root.appendChild(buildGrid(doc, t, null));
  formatSubtree(doc, root, 0);
  return serializeXml(doc);
}

export function titleBlockModified(t: TitleBlockTemplate): boolean {
  if (!t.xml) return true;
  try {
    return tbSignature(parseTitleBlockTemplate(t.xml)) !== tbSignature(t);
  } catch {
    return true;
  }
}

/** Total height of a template (sum of row heights) — TitleBlockTemplate::height(). */
export const titleBlockHeight = (t: TitleBlockTemplate) => t.rows.reduce((a, b) => a + b, 0);

/** Qt's qRound for positive/negative values. */
const qRound = (v: number) => (v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5));

/**
 * Column widths for a given total width — a port of TitleBlockTemplate::columnsWidth():
 * absolute and t% widths first, r% of the remaining width, then rounding compensation.
 */
export function titleBlockColumnWidths(t: TitleBlockTemplate, total: number): number[] {
  const out = t.cols.map(() => 0);
  let absSum = 0;
  let relSum = 0;
  const relative: number[] = [];
  t.cols.forEach((c, i) => {
    if (c.kind === "abs") {
      absSum += c.v;
      out[i] = c.v;
    } else if (c.kind === "t") {
      out[i] = qRound((total * c.v) / 100);
      relative.push(i);
      absSum += out[i];
    }
  });
  const remaining = total - absSum;
  t.cols.forEach((c, i) => {
    if (c.kind === "r") {
      out[i] = qRound((remaining * c.v) / 100);
      relative.push(i);
      relSum += out[i];
    }
  });
  let diff = total - absSum - relSum;
  if (relative.length && diff && Math.abs(diff) <= relative.length * 0.5) {
    const share = diff > 0 ? 1 : -1;
    while (diff) {
      for (const i of relative) {
        out[i] += share;
        diff -= share;
        if (!diff) break;
      }
    }
  }
  return out;
}
