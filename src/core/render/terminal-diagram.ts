/**
 * Terminal diagram sheet (generated page, `page.kind === "terminals"`): one strip drawn as a row of
 * terminals side by side in a box, the way terminal strips are documented on a "terminal diagram"
 * sheet — terminal numbers in the cells, bridges as lines with dots between bridged terminals, and
 * for every terminal what its top and bottom connect to (wire number nearest the strip, then the
 * device and pin, coloured like the wire). Everything comes from the schematic: terminals are drawn
 * there as single symbols with references like "X1:3"; this sheet follows automatically.
 *
 * The layout is shared by rendering and cross references (click a terminal → its schematic symbol).
 */
import type { Doc, Page, Rect, Styles } from "../model";
import { collectStrips, type StripView, type TerminalConn, type TerminalRowView } from "../terminals";
import { PathBuilder, type Painter } from "./painter";
import { sheetArea } from "./cover";

type Measure = Painter["measure"];

export type TdCell = { row: TerminalRowView; index: number; ref: string; rect: Rect; cx: number };
export type TdLayout = {
  view: StripView | null;
  tag: string;
  area: Rect;
  box: Rect;
  cells: TdCell[];
  cw: number;
  /** total terminals in the strip, first / last shown (1-based) */
  total: number;
  first: number;
  last: number;
  /** terminals of this page's range that did not fit */
  hidden: number;
  font: string;
  size: number;
  ink: string;
  /** sheet scale */
  u: number;
  style: "rail" | "box";
};

export const TD_MIN_CELL = 16;
export const TD_MAX_CELL = 30;

/** how many terminals fit across one terminal diagram sheet */
/** drawing scale of a sheet (1 = a 1000-unit wide frame) so the strip reads the same on big and small sheets */
const unit = (a: Rect) => Math.max(0.8, Math.min(2.2, a.w / 1000));

/** cell width range and the extra width (in cells) taken by end stops, marker carrier and end plate */
const geom = (style: "rail" | "box") => (style === "rail" ? { min: 20, max: 34, extra: 3.2 } : { min: TD_MIN_CELL, max: TD_MAX_CELL, extra: 0 });
export const diagramStyle = (page: Page): "rail" | "box" => page.terminalDiagram?.style ?? "rail";

export function terminalsPerSheet(page: Page): number {
  const a = sheetArea(page);
  const u = unit(a);
  const g = geom(diagramStyle(page));
  return Math.max(1, Math.floor((a.w - 70 * u) / (g.min * u) - g.extra));
}

const layoutCache = new WeakMap<Page, { doc: Doc; l: TdLayout }>();

export function terminalDiagramLayout(doc: Doc, page: Page, styles: Styles, views?: StripView[]): TdLayout {
  const hit = layoutCache.get(page);
  if (hit && hit.doc === doc) return hit.l;
  const td = page.terminalDiagram ?? { tag: "" };
  const all = views ?? collectStrips(doc);
  const view = all.find((v) => v.tag === td.tag) ?? null;
  const a = sheetArea(page);
  const font = styles.text.componentRef.font;
  const ink = styles.text.titleBlockField.color;
  const rows = view?.rows ?? [];
  const total = rows.length;
  const first = Math.max(1, td.from ?? 1);
  const wanted = rows.slice(first - 1, td.to ? Math.max(first - 1, td.to) : undefined);
  const u = unit(a);
  const style = diagramStyle(page);
  const g = geom(style);
  const leftPad = 54 * u;
  const usable = a.w - leftPad - 16 * u;
  const fit = Math.max(1, Math.floor(usable / (g.min * u) - g.extra));
  const shown = wanted.slice(0, fit);
  const cw = Math.max(g.min * u, Math.min(g.max * u, usable / Math.max(1, shown.length + g.extra)));
  const boxW = cw * shown.length;
  const bh = style === "rail" ? Math.max(80 * u, Math.min(120 * u, a.h * 0.2)) : Math.max(46 * u, Math.min(70 * u, a.h * 0.12));
  // rail: end stop + marker carrier on the left (2.1 cells), end plate + end stop on the right
  const lead = style === "rail" ? cw * 2.1 : 0;
  const x0 = a.x + leftPad + lead + Math.max(0, (usable - boxW - cw * g.extra) / 2);
  const y0 = a.y + a.h * 0.5 - bh / 2;
  const sep = view?.sep ?? ":";
  const cells: TdCell[] = shown.map((row, i) => ({
    row,
    index: first + i,
    ref: row.num ? `${td.tag}${sep}${row.num}` : td.tag,
    rect: { x: x0 + i * cw, y: y0, w: cw, h: bh },
    cx: x0 + i * cw + cw / 2,
  }));
  const l: TdLayout = {
    view,
    tag: td.tag,
    area: a,
    box: { x: x0, y: y0, w: boxW, h: bh },
    cells,
    cw,
    total,
    first,
    last: first + shown.length - 1,
    hidden: wanted.length - shown.length,
    font,
    size: Math.min(9.5 * u, Math.max(6.5 * u, cw * 0.42)),
    ink,
    u,
    style,
  };
  layoutCache.set(page, { doc, l });
  return l;
}

const sideText = (c: TerminalConn[]) => ({
  wire: [...new Set(c.map((x) => [x.wire, x.cable ? `(${x.cable})` : ""].filter(Boolean).join(" ")).filter(Boolean))].join(" / "),
  to: [...new Set(c.flatMap((x) => x.to))].join(", "),
  hex: c.find((x) => x.hex)?.hex,
});

function fitText(t: string, max: number, size: number, font: string, measure: Measure) {
  if (!t || measure(t, size, font) <= max) return t;
  let s = t;
  while (s.length > 1 && measure(s + "…", size, font) > max) s = s.slice(0, -1);
  return s + "…";
}

export function drawTerminalDiagram(pt: Painter, doc: Doc, page: Page, styles: Styles, measure: Measure) {
  const L = terminalDiagramLayout(doc, page, styles);
  const { area: a, box, cells, cw, font, ink, size, u } = L;
  pt.begin?.("terminal-diagram");
  // heading
  const strip = L.view?.strip;
  const title = L.tag ? `Terminal strip ${L.tag}` : "Terminal strip";
  pt.text({ text: title, x: a.x, y: a.y, size: 16 * u, font, weight: 700, color: ink, baseline: "top" });
  const sub = [
    strip?.description,
    strip?.location ? `location ${strip.location}` : "",
    strip?.partNumber ? `${strip.manufacturer ? `${strip.manufacturer} ` : ""}${strip.partNumber}` : "",
    L.total ? (L.first > 1 || L.last < L.total ? `terminals ${L.first}–${L.last} of ${L.total}` : `${L.total} terminal${L.total === 1 ? "" : "s"}`) : "",
  ].filter(Boolean);
  if (sub.length) pt.text({ text: sub.join("  ·  "), x: a.x, y: a.y + 22 * u, size: 8.5 * u, font, color: "#4b5563", baseline: "top" });
  if (!L.view || !cells.length) {
    pt.text({
      text: L.tag ? `Strip ${L.tag} has no terminals yet — give terminal symbols on the schematic references like ${L.tag}:1, or add terminals in Terminal strips…` : "Choose the strip to show in the page properties.",
      x: a.x + a.w / 2,
      y: a.y + a.h / 2,
      size: 10,
      font,
      color: "#6b7280",
      align: "center",
      baseline: "middle",
    });
    pt.end?.();
    return;
  }
  // strip designation left of the box (the rail view has it on the marker carrier)
  if (L.style === "box") pt.text({ text: L.tag, x: box.x - 10, y: box.y + box.h / 2, size: 13 * u, font, weight: 700, color: ink, align: "right", baseline: "middle" });

  // conductors above and below
  const topRoom = box.y - (a.y + 40 * u);
  const botRoom = a.y + a.h - (box.y + box.h) - 6;
  const tsize = Math.min(8.5 * u, Math.max(6 * u, cw * 0.4));
  for (const c of cells) {
    for (const side of [1, 2] as const) {
      const all = side === 1 ? c.row.conn1 : c.row.conn2;
      if (!all.length) continue;
      // several conductors on one side (double-wired clamp): one line each, side by side
      const groups = all.length > 3 ? [all.slice(0, 2), all.slice(2)] : all.map((x) => [x]);
      const n = groups.length;
      const step = n > 1 ? Math.min(cw * 0.32, (cw * 0.8) / (n - 1)) : 0;
      groups.forEach((conns, gi) => {
        const t = sideText(conns);
        const x = c.cx + (gi - (n - 1) / 2) * step;
        const ts = n > 1 ? tsize * 0.85 : tsize;
        const room = side === 1 ? topRoom : botRoom;
        const ww = t.wire ? measure(t.wire, ts, font) : 0;
        const tw = t.to ? measure(t.to, ts, font, 600) : 0;
        const len = Math.min(room, Math.max(28 * u, ww + tw + 22 * u));
        const yEdge = side === 1 ? box.y : box.y + box.h;
        const yEnd = side === 1 ? yEdge - len : yEdge + len;
        const col = t.hex && t.hex.toLowerCase() !== "#ffffff" ? t.hex : ink;
        pt.stroke(new PathBuilder().M(x, yEdge).L(x, yEnd).build(), { color: col, width: 1, minPx: 1 });
        pt.stroke(new PathBuilder().E(x, yEdge, 1.6, 1.6).build(), { color: ink, width: 0.7, minPx: 0.75 });
        // texts read bottom to top, left of the conductor: wire number next to the strip, then the destination
        const tx = x - 1.5;
        const wireMax = Math.max(0, len - 8);
        const wtxt = fitText(t.wire, wireMax, ts, font, measure);
        const wwf = wtxt ? measure(wtxt, ts, font) : 0;
        const left = len - (wtxt ? wwf + 12 : 5);
        const ttxt = left > 10 ? fitText(t.to, left, ts, font, measure) : "";
        if (side === 1) {
          if (wtxt) pt.text({ text: wtxt, x: tx, y: yEdge - 5, size: ts, font, color: ink, rotation: -90, baseline: "bottom" });
          if (ttxt) pt.text({ text: ttxt, x: tx, y: yEdge - (wtxt ? wwf + 12 : 5), size: ts, font, weight: 600, color: ink, rotation: -90, baseline: "bottom" });
        } else {
          if (wtxt) pt.text({ text: wtxt, x: tx, y: yEdge + 5 + wwf, size: ts, font, color: ink, rotation: -90, baseline: "bottom" });
          if (ttxt) pt.text({ text: ttxt, x: tx, y: yEnd, size: ts, font, weight: 600, color: ink, rotation: -90, baseline: "bottom" });
        }
      });
    }
  }

  if (L.style === "rail") {
    drawRail(pt, L, measure);
    notesOf(pt, L);
    pt.end?.();
    return;
  }

  // the strip: cells, numbers, type marks
  const cellPath = new PathBuilder();
  for (const c of cells) {
    const r = c.rect;
    if (c.row.type === "pe") pt.fill(new PathBuilder().R(r.x, r.y + r.h - 7, r.w, 7).build(), "#16a34a", 0.35);
    cellPath.M(r.x, r.y).L(r.x, r.y + r.h);
    const num = c.row.num ?? "?";
    const nsize = Math.min(size + 1.5, (cw - 3) / Math.max(1, num.length * 0.62));
    pt.text({ text: num, x: c.cx, y: r.y + r.h * 0.42, size: nsize, font, weight: 700, color: c.row.spare ? "#9ca3af" : ink, align: "center", baseline: "middle" });
    // screw / clamp symbol
    pt.stroke(new PathBuilder().E(c.cx, r.y + r.h * 0.74, Math.min(2.6, cw * 0.14), Math.min(2.6, cw * 0.14)).build(), { color: ink, width: 0.7, minPx: 0.75 });
    const mark = c.row.type === "feed" || !c.row.type ? "" : c.row.type === "pe" ? "PE" : c.row.type === "neutral" ? "N" : c.row.type === "fuse" ? "F" : c.row.type === "disconnect" ? "T" : c.row.type === "diode" ? "D" : c.row.type === "sensor" ? "S" : "ML";
    if (mark) pt.text({ text: mark, x: c.cx, y: r.y + r.h - 1.5, size: 5.5, font, weight: 600, color: ink, align: "center", baseline: "bottom" });
    if (c.row.spare) pt.text({ text: "spare", x: c.cx, y: r.y + r.h + 3, size: 5, font, color: "#9ca3af", align: "center", baseline: "top" });
  }
  cellPath.M(box.x + box.w, box.y).L(box.x + box.w, box.y + box.h);
  pt.stroke(cellPath.build(), { color: ink, width: 0.8, minPx: 0.75 });
  pt.stroke(new PathBuilder().R(box.x, box.y, box.w, box.h).build(), { color: ink, width: 1.6, minPx: 1.2 });

  // bridges: a line with dots joining bridged neighbours, inside the top of the strip
  const by = box.y + Math.min(9, box.h * 0.16);
  for (let i = 0; i < cells.length - 1; i++) {
    if (!cells[i].row.row?.bridge) continue;
    const a1 = cells[i].cx, a2 = cells[i + 1].cx;
    pt.stroke(new PathBuilder().M(a1, by).L(a2, by).build(), { color: ink, width: 1.2, minPx: 1 });
    for (const x of [a1, a2]) pt.fill(new PathBuilder().E(x, by, 1.5, 1.5).build(), ink);
  }

  notesOf(pt, L);
  pt.end?.();
}

function notesOf(pt: Painter, L: TdLayout) {
  const { area: a, font } = L;
  // continuation note
  const notes: string[] = [];
  if (L.first > 1) notes.push(`terminals 1–${L.first - 1} on the previous sheet`);
  if (L.hidden > 0) notes.push(`${L.hidden} more terminal${L.hidden === 1 ? "" : "s"} do not fit — split the strip over more sheets (page properties)`);
  else if (L.last < L.total) notes.push(`continued: terminals ${L.last + 1}–${L.total} on the next sheet`);
  if (notes.length) pt.text({ text: notes.join("  ·  "), x: a.x + a.w, y: a.y + a.h, size: 7.5 * L.u, font, italic: true, color: "#6b7280", align: "right", baseline: "bottom" });
}

/* ---------- DIN rail view ---------- */

const RAIL = { rail: "#c7ccd2", railEdge: "#8b949e", slot: "#eef0f2", block: "#5b6773", blockEdge: "#2f3740", cap: "#6b7783", screw: "#c9d1d9", screwEdge: "#2f3740", marker: "#f8fafc", plate: "#3a434d", carrier: "#d5dbe1" };
const TYPE_FILL: Partial<Record<string, string>> = { pe: "#3f8f4f", neutral: "#3567b5", fuse: "#6b5b73", disconnect: "#7a6a4f" };

/**
 * Terminals as they sit on the rail: DIN rail with slots behind, an end stop and the strip's marker
 * carrier ("-X1 (24 V)") at the start, the terminal blocks (screw on top, bridge channel, screw at
 * the bottom; PE green, N blue), plugged-in bridges, end plate and end stop at the end.
 */
function drawRail(pt: Painter, L: TdLayout, measure: Measure) {
  const { box, cells, cw, font, ink, u } = L;
  const strip = L.view?.strip;
  const y0 = box.y, bh = box.h;
  const midY = y0 + bh / 2;
  const topScrew = y0 + bh * 0.17, botScrew = y0 + bh * 0.83;
  const sr = Math.min(cw * 0.3, bh * 0.09);
  const stopW = cw * 0.65, carrierW = cw * 1.35, plateW = Math.max(2.5 * u, cw * 0.22);
  const left = box.x - carrierW - stopW - 2 * u;
  const right = box.x + box.w + plateW + stopW + 2 * u;
  // rail with slots
  const railH = bh * 0.3;
  const rx0 = left - cw * 0.9, rx1 = right + cw * 0.9;
  pt.fill(new PathBuilder().R(rx0, midY - railH / 2, rx1 - rx0, railH).build(), RAIL.rail);
  pt.stroke(new PathBuilder().M(rx0, midY - railH / 2).L(rx1, midY - railH / 2).M(rx0, midY + railH / 2).L(rx1, midY + railH / 2).build(), { color: RAIL.railEdge, width: 0.8, minPx: 0.5 });
  const slotW = cw * 1.1, slotH = railH * 0.32, pitch = cw * 1.8;
  for (let x = rx0 + cw * 0.3; x + slotW < rx1; x += pitch) pt.fill(new PathBuilder().RR(x, midY - slotH / 2, slotW, slotH, slotH / 2, slotH / 2).build(), RAIL.slot);

  const block = (x: number, w: number, h: number, fill: string) => {
    const y = midY - h / 2;
    pt.fill(new PathBuilder().RR(x, y, w, h, 1.2 * u, 1.2 * u).build(), fill);
    pt.stroke(new PathBuilder().RR(x, y, w, h, 1.2 * u, 1.2 * u).build(), { color: RAIL.blockEdge, width: 0.7, minPx: 0.5 });
  };
  const screw = (cx: number, cy: number, r: number) => {
    pt.fill(new PathBuilder().E(cx, cy, r, r).build(), RAIL.screw);
    pt.stroke(new PathBuilder().E(cx, cy, r, r).build(), { color: RAIL.screwEdge, width: 0.6, minPx: 0.5 });
    const d = r * 0.55;
    pt.stroke(new PathBuilder().M(cx - d, cy + d).L(cx + d, cy - d).M(cx - d * 0.6, cy - d * 0.6).L(cx + d * 0.6, cy + d * 0.6).build(), { color: RAIL.screwEdge, width: Math.max(0.6, r * 0.22), minPx: 0.5 });
  };
  // end stops (clamps) at both ends
  for (const x of [left, right - stopW]) {
    block(x, stopW, bh * 0.62, RAIL.plate);
    screw(x + stopW / 2, midY - bh * 0.18, Math.min(sr, stopW * 0.32));
  }
  // marker carrier with the strip designation and its description
  const cx0 = left + stopW + 1 * u;
  block(cx0, carrierW, bh * 1.04, RAIL.carrier);
  const label = [strip?.tag ?? L.tag, strip?.description ? `(${strip.description})` : ""].filter(Boolean).join(" ");
  const ls = Math.min(carrierW * 0.62, 13 * u);
  const lw = measure(label, ls, font, 700);
  const fitS = lw > bh * 0.95 ? ls * ((bh * 0.95) / lw) : ls;
  pt.text({ text: label, x: cx0 + carrierW / 2, y: midY, size: fitS, font, weight: 700, color: "#1f2937", rotation: -90, align: "center", baseline: "middle" });

  // terminal blocks
  for (const c of cells) {
    const r = c.rect;
    const fill = c.row.spare ? "#8a949e" : TYPE_FILL[c.row.type] ?? RAIL.block;
    pt.fill(new PathBuilder().R(r.x, r.y, r.w, r.h).build(), fill);
    // lighter clamp housings top and bottom
    for (const yy of [r.y, r.y + r.h * 0.66]) pt.fill(new PathBuilder().R(r.x + r.w * 0.08, yy + r.h * 0.02, r.w * 0.84, r.h * 0.3).build(), RAIL.cap, 0.55);
    if (c.row.type === "pe") pt.fill(new PathBuilder().R(r.x + r.w * 0.38, r.y, r.w * 0.24, r.h).build(), "#facc15", 0.85);
    pt.stroke(new PathBuilder().R(r.x, r.y, r.w, r.h).build(), { color: RAIL.blockEdge, width: 0.8, minPx: 0.5 });
    screw(c.cx, topScrew, sr);
    screw(c.cx, botScrew, sr);
    // bridge channel
    pt.fill(new PathBuilder().E(c.cx, midY, sr * 0.55, sr * 0.55).build(), "#1f2329");
    // marker (terminal number)
    const num = c.row.num ?? "?";
    const mh = bh * 0.13, mw = r.w * 0.8;
    const my = y0 + bh * 0.31;
    pt.fill(new PathBuilder().R(c.cx - mw / 2, my, mw, mh).build(), RAIL.marker);
    const ns = Math.min(mh * 0.85, (mw * 0.95) / Math.max(1, num.length * 0.6));
    pt.text({ text: num, x: c.cx, y: my + mh / 2, size: ns, font, weight: 700, color: c.row.spare ? "#6b7280" : "#111827", align: "center", baseline: "middle" });
    const mark = c.row.type === "pe" ? "PE" : c.row.type === "neutral" ? "N" : c.row.type === "fuse" ? "F" : c.row.type === "disconnect" ? "T" : c.row.type === "diode" ? "D" : c.row.type === "sensor" ? "S" : c.row.type === "multi" ? "ML" : "";
    if (mark) pt.text({ text: mark, x: c.cx, y: y0 + bh * 0.6, size: Math.min(6 * u, mw * 0.4), font, weight: 700, color: "#ffffff", align: "center", baseline: "middle" });
    if (c.row.spare) pt.text({ text: "spare", x: c.cx, y: y0 + bh + 2 * u, size: 5 * u, font, color: "#9ca3af", align: "center", baseline: "top" });
  }
  // end plate after the last terminal (closes the open side)
  block(box.x + box.w + 0.5 * u, plateW, bh * 1.02, RAIL.plate);

  // plugged-in bridges across the bridge channels
  for (let i = 0; i < cells.length - 1; i++) {
    if (!cells[i].row.row?.bridge) continue;
    let j = i + 1;
    while (j < cells.length - 1 && cells[j].row.row?.bridge) j++;
    const x1 = cells[i].cx, x2 = cells[j].cx;
    const h = sr * 0.9;
    pt.fill(new PathBuilder().RR(x1 - h * 0.6, midY - h / 2, x2 - x1 + h * 1.2, h, h / 2, h / 2).build(), "#c2410c");
    for (let k = i; k <= j; k++) pt.fill(new PathBuilder().E(cells[k].cx, midY, h * 0.32, h * 0.32).build(), "#fde68a");
    i = j - 1;
  }
  void ink;
}

/**
 * Pages needed for a strip: [from, to] ranges (1-based, last open-ended) so every terminal fits.
 */
export function splitRanges(count: number, perSheet: number): { from: number; to?: number }[] {
  const per = Math.max(1, perSheet);
  const out: { from: number; to?: number }[] = [];
  for (let from = 1; from <= Math.max(1, count); from += per) out.push({ from, to: from + per - 1 });
  if (out.length) delete out[out.length - 1].to;
  return out;
}

/**
 * Create (or re-create) the terminal diagram sheets of a strip: as many as needed so every terminal
 * fits, inserted after `afterPageId` (or where the strip's existing diagram sheets were, or at the
 * end), with the frame and title block of a drawing sheet. Returns the sheet ids.
 */
export function insertTerminalDiagram(doc: Doc, tag: string, o: { afterPageId?: string; perSheet?: number; newPage: (order: number, title: string) => Page }): string[] {
  const sorted = [...doc.pages].sort((a, b) => a.order - b.order);
  const old = sorted.filter((p) => p.kind === "terminals" && p.terminalDiagram?.tag === tag);
  const tpl = sorted.find((p) => p.id === o.afterPageId && !p.kind) ?? sorted.find((p) => !p.kind || p.kind === "drawing") ?? sorted[0];
  let at = old.length ? sorted.indexOf(old[0]) : o.afterPageId ? sorted.findIndex((p) => p.id === o.afterPageId) + 1 : sorted.length;
  if (at < 0) at = sorted.length;
  const rest = sorted.filter((p) => !old.includes(p));
  const before = rest.slice(0, at - (old.length ? 0 : 0)).filter((p) => sorted.indexOf(p) < at);
  const after = rest.filter((p) => !before.includes(p));
  const view = collectStrips(doc).find((v) => v.tag === tag);
  const count = view?.rows.length ?? 0;
  const probe = o.newPage(0, "");
  if (tpl) probe.border = { ...tpl.border };
  const per = o.perSheet ?? terminalsPerSheet(probe);
  const ranges = splitRanges(count, per);
  const made: Page[] = ranges.map((r, i) => {
    const title = `Terminal diagram ${tag}${ranges.length > 1 ? ` (${i + 1}/${ranges.length})` : ""}`;
    const prev = old[i];
    const p = o.newPage(0, title);
    if (prev) p.id = prev.id;
    p.kind = "terminals";
    p.terminalDiagram = { tag, ...r, ...(old[0]?.terminalDiagram?.style ? { style: old[0].terminalDiagram.style } : {}) };
    if (tpl) (p.border = { ...tpl.border }), (p.titleBlock = { ...tpl.titleBlock, fields: { ...tpl.titleBlock.fields, title } });
    return p;
  });
  doc.pages = [...doc.pages.filter((p) => !old.includes(p)), ...made];
  [...before, ...made, ...after].forEach((p, i) => (p.order = i));
  return made.map((p) => p.id);
}
