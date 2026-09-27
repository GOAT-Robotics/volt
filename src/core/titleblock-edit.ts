/**
 * Editing operations on title block templates (grid of rows × columns with spanning cells).
 * All functions are pure: they return a new template and never mutate their input.
 * Spans follow QET: rowspan/colspan count the *additional* rows/columns a cell covers.
 */
import type { TitleBlockTemplate } from "./model";

export type TbCell = TitleBlockTemplate["cells"][number];
type T = TitleBlockTemplate;

const clone = (t: T): T => ({ ...t, rows: [...t.rows], cols: t.cols.map((c) => ({ ...c })), cells: t.cells.map((c) => ({ ...c })), ...(t.logos ? { logos: { ...t.logos } } : {}) });

/** row/col ranges a cell covers (clipped to the grid) */
export function cellRect(t: T, c: TbCell) {
  return { r0: c.row, c0: c.col, r1: Math.min(t.rows.length - 1, c.row + c.rowspan), c1: Math.min(t.cols.length - 1, c.col + c.colspan) };
}

/** "row:col" → index of the (non-empty) cell covering it */
export function occupancy(t: T, skip?: number): Map<string, number> {
  const m = new Map<string, number>();
  t.cells.forEach((c, i) => {
    if (i === skip || c.type === "empty") return;
    const r = cellRect(t, c);
    for (let y = r.r0; y <= r.r1; y++) for (let x = r.c0; x <= r.c1; x++) m.set(`${y}:${x}`, i);
  });
  return m;
}

/** true when a cell at (row, col) with the spans fits in the grid without covering other cells */
export function fits(t: T, row: number, col: number, rowspan: number, colspan: number, skip?: number): boolean {
  if (row < 0 || col < 0 || row + rowspan > t.rows.length - 1 || col + colspan > t.cols.length - 1) return false;
  const occ = occupancy(t, skip);
  for (let y = row; y <= row + rowspan; y++) for (let x = col; x <= col + colspan; x++) if (occ.has(`${y}:${x}`)) return false;
  return true;
}

/** drops "empty" cells (the renderer draws uncovered slots on its own) */
const tidy = (t: T): T => ({ ...t, cells: t.cells.filter((c) => c.type !== "empty") });

export function addField(t: T, row: number, col: number, init: Partial<TbCell> = {}): { t: T; index: number } {
  const n = clone(t);
  n.cells.push({ row, col, rowspan: 0, colspan: 0, type: "field", name: "", label: "", value: "", showLabel: true, align: "left", ...init });
  return { t: n, index: n.cells.length - 1 };
}

export function updateCell(t: T, i: number, patch: Partial<TbCell>): T {
  const n = clone(t);
  n.cells[i] = { ...n.cells[i], ...patch };
  return n;
}

export function removeCell(t: T, i: number): T {
  const n = clone(t);
  n.cells.splice(i, 1);
  return n;
}

/** Moves a cell to (row, col); a single other cell exactly there with the same size swaps places. */
export function moveCell(t: T, i: number, row: number, col: number): T | null {
  const c = t.cells[i];
  if (!c || (c.row === row && c.col === col)) return null;
  if (fits(t, row, col, c.rowspan, c.colspan, i)) return updateCell(t, i, { row, col });
  const occ = occupancy(t, i);
  const j = occ.get(`${row}:${col}`);
  if (j === undefined) return null;
  const o = t.cells[j];
  if (o.row !== row || o.col !== col || o.rowspan !== c.rowspan || o.colspan !== c.colspan) return null;
  const n = clone(t);
  n.cells[i] = { ...n.cells[i], row, col };
  n.cells[j] = { ...n.cells[j], row: c.row, col: c.col };
  return n;
}

/** Sets a cell's span when the new area is free. */
export function spanCell(t: T, i: number, rowspan: number, colspan: number): T | null {
  const c = t.cells[i];
  if (!c || rowspan < 0 || colspan < 0) return null;
  return fits(t, c.row, c.col, rowspan, colspan, i) ? updateCell(t, i, { rowspan, colspan }) : null;
}

/** Merges the selected cells (and the free slots between them) into the first one, if their bounding box holds nothing else. */
export function mergeCells(t: T, indices: number[]): { t: T; index: number } | null {
  if (indices.length < 2) return null;
  const rs = indices.map((i) => cellRect(t, t.cells[i]));
  const r0 = Math.min(...rs.map((r) => r.r0)), c0 = Math.min(...rs.map((r) => r.c0));
  const r1 = Math.max(...rs.map((r) => r.r1)), c1 = Math.max(...rs.map((r) => r.c1));
  const sel = new Set(indices);
  const occ = occupancy(t);
  for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) {
    const k = occ.get(`${y}:${x}`);
    if (k !== undefined && !sel.has(k)) return null;
  }
  // keep the top-left-most selected cell's content
  const keep = [...indices].sort((a, b) => t.cells[a].row - t.cells[b].row || t.cells[a].col - t.cells[b].col)[0];
  const n = clone(t);
  n.cells[keep] = { ...n.cells[keep], row: r0, col: c0, rowspan: r1 - r0, colspan: c1 - c0 };
  const drop = new Set(indices.filter((i) => i !== keep));
  const cells = n.cells.filter((_, i) => !drop.has(i));
  return { t: { ...n, cells }, index: cells.indexOf(n.cells[keep]) };
}

/** Splits a spanning cell back to one slot (the freed slots become empty). */
export const splitCell = (t: T, i: number): T => updateCell(t, i, { rowspan: 0, colspan: 0 });

export function insertRow(t: T, at: number, height = 25): T {
  const n = clone(t);
  n.rows.splice(at, 0, height);
  for (const c of n.cells) {
    if (c.row >= at) c.row++;
    else if (c.row + c.rowspan >= at) c.rowspan++; // a cell spanning across grows
  }
  return n;
}

export function deleteRow(t: T, at: number): T | null {
  if (t.rows.length <= 1) return null;
  const n = clone(t);
  n.rows.splice(at, 1);
  const cells: TbCell[] = [];
  for (const c of n.cells) {
    if (c.row === at && c.rowspan === 0) continue; // only in this row: removed
    if (c.row > at) c.row--;
    else if (c.row + c.rowspan >= at) c.rowspan = Math.max(0, c.rowspan - 1);
    cells.push(c);
  }
  return tidy({ ...n, cells });
}

export function insertCol(t: T, at: number, col: TitleBlockTemplate["cols"][number] = { kind: "abs", v: 50 }): T {
  const n = clone(t);
  n.cols.splice(at, 0, { ...col });
  for (const c of n.cells) {
    if (c.col >= at) c.col++;
    else if (c.col + c.colspan >= at) c.colspan++;
  }
  return n;
}

export function deleteCol(t: T, at: number): T | null {
  if (t.cols.length <= 1) return null;
  const n = clone(t);
  n.cols.splice(at, 1);
  const cells: TbCell[] = [];
  for (const c of n.cells) {
    if (c.col === at && c.colspan === 0) continue;
    if (c.col > at) c.col--;
    else if (c.col + c.colspan >= at) c.colspan = Math.max(0, c.colspan - 1);
    cells.push(c);
  }
  return tidy({ ...n, cells });
}

/**
 * Moves the border between column i and i+1 by dx (scene units at total width `total`), keeping
 * the overall width: the neighbour gives or takes the same amount. Relative columns stay relative.
 */
export function resizeCol(t: T, i: number, dx: number, widths: number[], total: number): T {
  if (i < 0 || i >= t.cols.length - 1) return t;
  const min = 5;
  const d = Math.max(min - widths[i], Math.min(widths[i + 1] - min, dx));
  if (!d) return t;
  const n = clone(t);
  const target = widths.map((w, k) => (k === i ? w + d : k === i + 1 ? w - d : w));
  // fixed and total-relative columns take their new widths; remaining-relative ones share what is left
  n.cols.forEach((c, k) => {
    if (c.kind === "abs") c.v = Math.max(min, Math.round(target[k]));
    else if (c.kind === "t") c.v = Math.max(1, Math.round((target[k] / total) * 100));
  });
  const remaining = Math.max(1, total - n.cols.reduce((a, c, k) => a + (c.kind === "r" ? 0 : c.kind === "abs" ? c.v : target[k]), 0));
  // largest-remainder rounding so the shares still add up (QET only absorbs half a pixel per column)
  const rs = n.cols.map((c, k) => (c.kind === "r" ? { k, raw: (target[k] / remaining) * 100 } : null)).filter((x): x is { k: number; raw: number } => !!x);
  const want = Math.round(rs.reduce((a, x) => a + x.raw, 0));
  const floors = rs.map((x) => ({ ...x, v: Math.floor(x.raw) }));
  let left = want - floors.reduce((a, x) => a + x.v, 0);
  for (const x of [...floors].sort((a, b) => b.raw - Math.floor(b.raw) - (a.raw - Math.floor(a.raw)))) {
    if (left <= 0) break;
    x.v++;
    left--;
  }
  for (const x of floors) n.cols[x.k].v = Math.max(1, x.v);
  return n;
}

export function resizeRow(t: T, i: number, h: number): T {
  const n = clone(t);
  n.rows[i] = Math.max(5, Math.round(h));
  return n;
}

/** QET column spec text ("80", "80px", "r25%", "t10%") → column, or null */
export function parseColSpec(s: string): TitleBlockTemplate["cols"][number] | null {
  const p = s.trim();
  const abs = /^([0-9]+)(?:px)?$/i.exec(p);
  if (abs) return { kind: "abs", v: Math.max(1, parseInt(abs[1], 10)) };
  const rel = /^([rt])([0-9]+)%$/i.exec(p);
  if (rel) return { kind: rel[1].toLowerCase() === "t" ? "t" : "r", v: Math.max(1, parseInt(rel[2], 10)) };
  return null;
}
export const colSpec = (c: TitleBlockTemplate["cols"][number]) => (c.kind === "abs" ? `${c.v}px` : `${c.kind}${c.v}%`);

/** Variables (%name / %{name}) used anywhere in the template's field values */
export function templateVariables(t: T): Set<string> {
  const out = new Set<string>();
  for (const c of t.cells) if (c.type === "field") for (const m of (c.value ?? "").matchAll(/%\{?([\w-]+)\}?/g)) out.add(m[1]);
  return out;
}
