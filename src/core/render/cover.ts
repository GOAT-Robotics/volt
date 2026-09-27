/**
 * Generated pages: the cover sheet and the table of contents.
 *
 * Layout follows what large machine builders put on the first sheets of an electrical
 * documentation set (IEC 61082-1 document structure, IEC 60204-1 §17 technical documentation,
 * EPLAN / Siemens / ABB style cover sheets):
 *   - identification: document title, product, document number and revision, prominent;
 *   - technical data of the product / supply (key → value table);
 *   - manufacturer name and address (required marking information);
 *   - product picture;
 *   - revision history with drawn / checked / approved;
 *   - confidentiality notice.
 * The table of contents lists every sheet with its number and title.
 * Everything is drawn from project data, so it stays current and renders the same everywhere.
 */
import type { CoverSheet, Doc, Page, Rect, Styles } from "../model";
import { PathBuilder, type Painter } from "./painter";
import { fitContain, LOGO_MIME, logoKey, logoSize } from "../logos";
import { layoutRich } from "../richtext";

type Vars = Record<string, string>;
type Measure = Painter["measure"];

const MUTED = "#6b7280";
const RULE = "#d1d5db";
const HEAD_BG = "#f3f4f6";

export const DEFAULT_COVER: CoverSheet = {
  title: "%projecttitle",
  subtitle: "Electrical documentation",
  fields: [
    { label: "Product", value: "%projecttitle" },
    { label: "Model number", value: "" },
    { label: "Serial number", value: "" },
    { label: "Supply voltage", value: "" },
    { label: "Full load current", value: "" },
    { label: "Battery", value: "" },
    { label: "Charger", value: "" },
    { label: "Degree of protection", value: "" },
    { label: "Year of manufacture", value: "" },
    { label: "Applicable standards", value: "IEC 60204-1" },
  ],
  manufacturer: "",
  notes: "",
  notice: "© This document and its contents are the property of the manufacturer. Do not copy or disclose without written permission.",
  showRevisions: true,
};

/** usable area inside the border (between the row/column headers), with a margin */
export function sheetArea(page: Page, margin = 18): Rect {
  const b = page.border;
  const hx = b.show && b.showRows ? b.headerW : 0;
  const hy = b.show && b.showCols ? b.headerH : 0;
  return { x: hx + margin, y: hy + margin, w: b.cols * b.colW - margin * 2, h: b.rows * b.rowH - margin * 2 };
}

function subst(s: string, vars: Vars) {
  return s.replace(/%\{([\w-]+)\}|%([\w-]+)/g, (m, a, b) => vars[a ?? b] ?? m);
}

function fit(text: string, max: number, size: number, font: string, weight: number, measure: Measure) {
  if (measure(text, size, font, weight) <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid) + "…", size, font, weight) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "";
}

/** splits a text into lines that fit a width (word wrap) */
function wrap(text: string, max: number, size: number, font: string, weight: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next, size, font, weight) > max) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

function sectionLabel(pt: Painter, text: string, x: number, y: number, size: number, font: string, color: string) {
  pt.text({ text: text.toUpperCase(), x, y, size, font, weight: 700, color, baseline: "top" });
}

type Col = { label: string; w: number; align?: "left" | "center" };

function table(pt: Painter, r: Rect, cols: Col[], rows: string[][], size: number, font: string, color: string, measure: Measure, rowH: number) {
  const total = cols.reduce((a, c) => a + c.w, 0);
  const xs = [r.x];
  for (const c of cols) xs.push(xs[xs.length - 1] + (c.w / total) * r.w);
  pt.fill(new PathBuilder().R(r.x, r.y, r.w, rowH).build(), HEAD_BG);
  const grid = new PathBuilder().R(r.x, r.y, r.w, rowH * (rows.length + 1));
  for (let i = 1; i <= rows.length; i++) grid.M(r.x, r.y + i * rowH).L(r.x + r.w, r.y + i * rowH);
  for (let i = 1; i < cols.length; i++) grid.M(xs[i], r.y).L(xs[i], r.y + rowH * (rows.length + 1));
  pt.stroke(grid.build(), { color: RULE, width: 0.75, minPx: 1 });
  const cell = (text: string, i: number, y: number, weight: number, c: string) => {
    const x0 = xs[i] + 4, w = xs[i + 1] - xs[i] - 8;
    const t = fit(text, w, size, font, weight, measure);
    const center = cols[i].align === "center";
    pt.text({ text: t, x: center ? (xs[i] + xs[i + 1]) / 2 : x0, y: y + rowH / 2, size, font, weight, color: c, baseline: "middle", align: center ? "center" : "left" });
  };
  cols.forEach((c, i) => cell(c.label, i, r.y, 700, color));
  rows.forEach((row, j) => row.forEach((v, i) => cell(v, i, r.y + (j + 1) * rowH, 400, color)));
}

export function drawCoverSheet(pt: Painter, doc: Doc, page: Page, styles: Styles, vars: Vars, measure: Measure) {
  const c = { ...DEFAULT_COVER, ...(page.cover ?? {}) };
  const a = sheetArea(page);
  const font = styles.graphics.titleBlock.font;
  const ink = styles.text.titleBlockField.color;
  // type scale relative to the sheet (A3 landscape ≈ 1000 units wide)
  const u = Math.max(0.6, Math.min(1.6, a.w / 1000));
  const base = 11 * u, small = 8.5 * u, label = 8 * u;
  pt.begin?.("cover");

  // identification band
  const title = subst(c.title || "%projecttitle", vars) || doc.meta.title;
  const tSize = 30 * u;
  pt.text({ text: fit(title, a.w * 0.62, tSize, font, 700, measure), x: a.x, y: a.y, size: tSize, font, weight: 700, color: ink, baseline: "top" });
  let y = a.y + tSize * 1.2;
  if (c.subtitle) {
    pt.text({ text: fit(subst(c.subtitle, vars), a.w * 0.62, 14 * u, font, 400, measure), x: a.x, y, size: 14 * u, font, color: MUTED, baseline: "top" });
    y += 14 * u * 1.4;
  }
  // document number / revision / date boxes on the right of the band
  // identification: title block fields first, else the matching product data rows
  const field = (re: RegExp) => subst(c.fields.find((f) => re.test(f.label) && f.value.trim())?.value ?? "", vars);
  const lastRev = doc.revisions?.length ? doc.revisions[doc.revisions.length - 1] : null;
  const idBox: [string, string][] = [
    ["Document no.", vars.docnumber || vars.documentnumber || field(/doc(ument)?\.?\s*(no|number|nr)/i) || vars.filename || ""],
    ["Revision", vars.indexrev || field(/^rev(ision)?\.?\s*(no|number|nr)?$/i) || lastRev?.rev || ""],
    ["Date", field(/(issue|revision|release)\s*date/i) || lastRev?.date || vars.date || ""],
  ];
  const bw = a.w * 0.34, bx = a.x + a.w - bw, bh = 44 * u;
  const cw = bw / 3;
  pt.stroke(new PathBuilder().R(bx, a.y, bw, bh).M(bx + cw, a.y).L(bx + cw, a.y + bh).M(bx + 2 * cw, a.y).L(bx + 2 * cw, a.y + bh).build(), { color: ink, width: 1, minPx: 1 });
  idBox.forEach(([l, v], i) => {
    pt.text({ text: l.toUpperCase(), x: bx + i * cw + 6, y: a.y + 6 * u, size: label, font, weight: 700, color: MUTED, baseline: "top" });
    pt.text({ text: fit(v || "—", cw - 12, 13 * u, font, 700, measure), x: bx + i * cw + 6, y: a.y + bh - 8 * u, size: 13 * u, font, weight: 700, color: ink, baseline: "bottom" });
  });
  y = Math.max(y, a.y + bh) + 10 * u;
  pt.stroke(new PathBuilder().M(a.x, y).L(a.x + a.w, y).build(), { color: ink, width: 2, minPx: 1.5 });
  y += 18 * u;

  // bottom: notice, then revision history above it
  let bottom = a.y + a.h;
  if (c.notice) {
    const lines = wrap(subst(c.notice, vars), a.w, small, font, 400, measure).slice(0, 2);
    bottom -= lines.length * small * 1.35;
    lines.forEach((l, i) => pt.text({ text: l, x: a.x, y: bottom + i * small * 1.35, size: small, font, italic: true, color: MUTED, baseline: "top" }));
    bottom -= 8 * u;
  }
  if (c.showRevisions !== false) {
    const revs = [...(doc.revisions ?? [])].reverse().slice(0, 6);
    const rowH = base * 1.9;
    const rows = revs.length ? revs.map((r) => [r.rev, r.date, r.description, r.drawn ?? "", r.checked ?? "", r.approved ?? ""]) : [["", "", "", "", "", ""]];
    const h = rowH * (rows.length + 1);
    const top = bottom - h;
    sectionLabel(pt, "Revision history", a.x, top - label * 2, label, font, MUTED);
    table(pt, { x: a.x, y: top, w: a.w, h }, [{ label: "Rev.", w: 7, align: "center" }, { label: "Date", w: 13 }, { label: "Description", w: 44 }, { label: "Drawn", w: 12 }, { label: "Checked", w: 12 }, { label: "Approved", w: 12 }], rows, small * 1.1, font, ink, measure, rowH);
    bottom = top - label * 2 - 14 * u;
  }

  // main: data (left) | picture + notes (right)
  const leftW = a.w * (c.image ? 0.56 : 1);
  const colGap = 28 * u;
  let ly = y;
  if (c.fields.length) {
    sectionLabel(pt, "Product data", a.x, ly, label, font, MUTED);
    ly += label * 2;
    const rowH = base * 2.05;
    const lw = Math.min(leftW * 0.42, 190 * u);
    for (const f of c.fields) {
      if (ly + rowH > bottom) break;
      const v = subst(f.value, vars);
      pt.text({ text: fit(f.label, lw - 8, base, font, 400, measure), x: a.x, y: ly + rowH / 2, size: base, font, color: MUTED, baseline: "middle" });
      pt.text({ text: fit(v || "—", leftW - lw - 4, base, font, 600, measure), x: a.x + lw, y: ly + rowH / 2, size: base, font, weight: 600, color: v ? ink : MUTED, baseline: "middle" });
      ly += rowH;
      pt.stroke(new PathBuilder().M(a.x, ly).L(a.x + leftW, ly).build(), { color: RULE, width: 0.75, minPx: 1 });
    }
    ly += 16 * u;
  }
  if (c.manufacturer?.trim() && ly + base * 4 < bottom) {
    sectionLabel(pt, "Manufacturer", a.x, ly, label, font, MUTED);
    ly += label * 2;
    const lines = subst(c.manufacturer, vars).split("\n").map((l) => l.trim()).filter(Boolean);
    lines.forEach((l, i) => {
      if (ly + base * 1.4 > bottom) return;
      pt.text({ text: fit(l, leftW, base, font, i === 0 ? 700 : 400, measure), x: a.x, y: ly, size: base, font, weight: i === 0 ? 700 : 400, color: ink, baseline: "top" });
      ly += base * 1.4;
    });
  }
  if (c.image) {
    const rx = a.x + leftW + colGap, rw = a.w - leftW - colGap;
    let ry = y;
    const nat = logoSize(c.image);
    const notesH = c.notes?.trim() ? Math.min((bottom - y) * 0.35, 160 * u) : 0;
    const box = { x: rx, y: ry, w: rw, h: bottom - ry - notesH - (notesH ? 12 * u : 0) };
    if (nat && pt.image && box.h > 20) pt.image({ key: logoKey(c.image), mime: LOGO_MIME[c.image.type], data: c.image.data, ...fitContain(nat, box, 4) });
    ry = box.y + box.h + 12 * u;
    if (notesH) drawNotes(pt, c.notes!, { x: rx, y: ry, w: rw, h: notesH }, base, font, ink, measure);
  } else if (c.notes?.trim() && ly + base * 3 < bottom) {
    drawNotes(pt, c.notes, { x: a.x, y: ly + 10 * u, w: leftW, h: bottom - ly - 10 * u }, base, font, ink, measure);
  }
  pt.end?.();
}

function drawNotes(pt: Painter, notes: string, r: Rect, base: number, font: string, ink: string, measure: Measure) {
  const st = { font, size: base / (4 / 3), weight: 400, italic: false, color: ink, background: null, align: "left" as const, rotation: 0, dx: 0, dy: 0, lineHeight: 1.3, visible: true };
  const l = layoutRich(notes, st, { width: r.w, padding: 0, paraGap: 2 }, measure);
  for (const it of l.items) if (it.y + it.size <= r.h) pt.text({ text: it.text, x: r.x + it.x, y: r.y + it.y, size: it.size, font, weight: it.weight, italic: it.italic, color: ink, baseline: "top" });
}

export function drawContents(pt: Painter, doc: Doc, page: Page, styles: Styles, measure: Measure) {
  const a = sheetArea(page);
  const font = styles.graphics.titleBlock.font;
  const ink = styles.text.titleBlockField.color;
  const u = Math.max(0.6, Math.min(1.6, a.w / 1000));
  const base = 10.5 * u;
  pt.begin?.("contents");
  pt.text({ text: "Table of contents", x: a.x, y: a.y, size: 22 * u, font, weight: 700, color: ink, baseline: "top" });
  const y0 = a.y + 22 * u * 1.5;
  pt.stroke(new PathBuilder().M(a.x, y0).L(a.x + a.w, y0).build(), { color: ink, width: 2, minPx: 1.5 });
  const pages = [...doc.pages].filter((p) => !p.archived).sort((p, q) => p.order - q.order);
  const rowH = base * 1.9;
  const top = y0 + 14 * u;
  const perCol = Math.max(1, Math.floor((a.y + a.h - top) / rowH) - 1);
  const ncol = Math.min(3, Math.ceil(pages.length / perCol));
  const gap = 24 * u;
  const cw = (a.w - gap * (ncol - 1)) / ncol;
  for (let c = 0; c < ncol; c++) {
    const chunk = pages.slice(c * perCol, (c + 1) * perCol);
    const rows = chunk.map((p) => {
      const i = pages.indexOf(p);
      const kind = p.kind === "cover" ? "Cover sheet" : p.kind === "contents" ? "Contents" : p.titleBlock.fields.indexrev || "";
      return [String(i + 1), p.titleBlock.fields.title || p.title, kind];
    });
    table(pt, { x: a.x + c * (cw + gap), y: top, w: cw, h: rowH * (rows.length + 1) }, [{ label: "Sheet", w: 10, align: "center" }, { label: "Title", w: 66 }, { label: "Rev. / type", w: 24 }], rows, base, font, ink, measure, rowH);
  }
  pt.end?.();
}

/**
 * A cover sheet pre-filled from "Label : value" lines typed on a page (how covers are usually
 * made by hand); lines after a "…manufacturer…:" label with no value become the address.
 */
export function coverFromPageTexts(page: Page): { cover: CoverSheet; used: string[] } {
  const lines: { text: string; id: string; indented: boolean }[] = [];
  for (const t of [...page.texts].sort((a, b) => a.y - b.y || a.x - b.x))
    for (const l of t.text.split("\n")) if (l.trim()) lines.push({ text: l.replace(/\*\*/g, "").trim(), id: t.id, indented: /^\s{4,}/.test(l) });
  const fields: CoverSheet["fields"] = [];
  const used = new Set<string>();
  const mf: string[] = [];
  let title: string | undefined;
  let inAddress = false;
  for (const { text, id, indented } of lines) {
    // inside the address block, indented lines are address lines even if they contain ":"
    const m: RegExpExecArray | null = inAddress && indented ? null : /^(?:[o•\-*]\s+)?([^:]{2,60}?)\s*:\s*(.*)$/.exec(text);
    if (m) {
      const label = m[1].trim(), value = m[2].trim();
      used.add(id);
      inAddress = /manufacturer/i.test(label) && /name|address/i.test(label) && !value;
      if (inAddress) continue;
      if (/^name$/i.test(label) && !title) title = value;
      fields.push({ label, value });
    } else if (inAddress) {
      mf.push(text);
      used.add(id);
    }
  }
  return {
    cover: {
      ...structuredClone(DEFAULT_COVER),
      ...(title ? { title } : {}),
      fields: fields.length ? fields.map((f) => (/^name$/i.test(f.label) ? { ...f, label: "Product" } : f)) : structuredClone(DEFAULT_COVER.fields),
      manufacturer: mf.join("\n"),
    },
    used: [...used],
  };
}
