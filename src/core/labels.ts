/**
 * Wire marker labels for harness building: one label per wire end (or per wire), with the wire
 * identifier and optionally where that end lands and where the wire goes, its colour and size.
 * Layout is computed in millimetres for a label medium (Brother TZe tape, HSe heat-shrink tube,
 * self-laminating wrap, or a sheet) and drawn by the canvas renderer (preview, direct printing) and
 * the PDF writer the same way.
 */
import type { Doc, Page, Wire, WireEnd } from "./model";
import { colorLabel, wireInfo, wiringOf } from "./wiring";

export type LabelRecord = {
  key: string;
  wireId: string;
  pageId: string;
  sheet: number;
  /** wire identifier (number) */
  id: string;
  end: "a" | "b" | "both";
  /** terminal this end lands on ("K1:A1"), splice, or continuation */
  here: string;
  /** the other end */
  there: string;
  color: string;
  section: string;
  cable: string;
};

export type LabelContent = {
  /** one label per end (the usual harness practice) or one per wire */
  perEnd: boolean;
  /** second line: "K1:A1 → F1:2" (this end → other end), "→ F1:2" (destination), or nothing */
  detail: "route" | "destination" | "here" | "none";
  /** add colour / cross-section to the detail line */
  conductor: boolean;
  /** wires without a number get one label with their route only (true) or are skipped (false) */
  includeUnnumbered: boolean;
};

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function endText(doc: Doc, page: Page, end: WireEnd, sheets: Map<string, number>): string {
  if (end.k === "free") return "open";
  if (end.k === "junction") return "splice";
  const e = page.elements.find((x) => x.id === end.el);
  if (!e) return "?";
  const def = doc.defs[e.defId];
  // a folio report: the conductor continues on another sheet
  if (def && (def.linkType === "next_report" || def.linkType === "previous_report")) {
    const other = e.links?.[0] && doc.pages.find((p) => p.elements.some((x) => x.id === e.links![0]));
    return other ? `→ sheet ${sheets.get(other.id) ?? "?"}` : "continues";
  }
  const pin = def?.pins.find((p) => p.id === end.pin);
  // a device without reference: its prefix or the first word of its name, kept short for the label
  const ref = e.info.label || (def?.prefix ? `${def.prefix}?` : (def?.name ?? "?").split(/[\s,;(]+/)[0].slice(0, 10));
  const p = pin?.number || pin?.name;
  return p ? `${ref}:${p}` : ref;
}

/** label records for the given wires (all wires of the project by default), sorted for assembly */
export function labelRecords(doc: Doc, opts: { wireIds?: Set<string>; pageIds?: Set<string>; cable?: string; content: LabelContent; sort?: "number" | "sheet" | "device" }): LabelRecord[] {
  const pages = [...doc.pages].filter((p) => !p.archived && p.kind !== "cover" && p.kind !== "contents").sort((a, b) => a.order - b.order);
  const sheets = new Map(pages.map((p, i) => [p.id, i + 1]));
  const std = wiringOf(doc).standard;
  const out: LabelRecord[] = [];
  for (const page of pages) {
    if (opts.pageIds && !opts.pageIds.has(page.id)) continue;
    for (const w of page.wires) {
      if (opts.wireIds && !opts.wireIds.has(w.id)) continue;
      if (opts.cable && w.cable !== opts.cable) continue;
      if (!w.label && !opts.content.includeUnnumbered) continue;
      const info = wireInfo(doc, w);
      const base = {
        wireId: w.id,
        pageId: page.id,
        sheet: sheets.get(page.id) ?? 0,
        id: w.label ?? "",
        color: info.color ? colorLabel(info.color, std) : "",
        section: info.section ?? "",
        cable: w.cable ? `${w.cable}${w.core ? `:${w.core}` : ""}` : "",
      };
      const a = endText(doc, page, w.a, sheets), b = endText(doc, page, w.b, sheets);
      if (opts.content.perEnd) {
        out.push({ ...base, key: `${w.id}:a`, end: "a", here: endLabelOverride(w, "a") ?? a, there: b });
        out.push({ ...base, key: `${w.id}:b`, end: "b", here: endLabelOverride(w, "b") ?? b, there: a });
      } else out.push({ ...base, key: w.id, end: "both", here: a, there: b });
    }
  }
  const sort = opts.sort ?? "number";
  out.sort((x, y) =>
    sort === "sheet"
      ? x.sheet - y.sheet || natural.compare(x.id, y.id) || x.end.localeCompare(y.end)
      : sort === "device"
        ? natural.compare(x.here, y.here) || natural.compare(x.id, y.id)
        : natural.compare(x.id || "￿", y.id || "￿") || x.end.localeCompare(y.end) || natural.compare(x.here, y.here),
  );
  return out;
}

/** a hand-written end name (Wire.endLabels) is what the electrician expects on that end */
function endLabelOverride(w: Wire, end: "a" | "b") {
  const v = w.endLabels?.[end]?.trim();
  return v ? v : undefined;
}

/** text of the second line */
export function detailLine(r: LabelRecord, c: LabelContent): string {
  const cond = c.conductor ? [r.color, r.section].filter(Boolean).join(" ") : "";
  let d = "";
  if (c.detail === "route") d = r.end === "both" ? `${r.here} ↔ ${r.there}` : `${r.here} → ${r.there}`;
  else if (c.detail === "destination") d = `→ ${r.there}`;
  else if (c.detail === "here") d = r.here;
  return [d, cond].filter(Boolean).join("  ");
}

/* ------------------------------------------------------------------ */
/* Media                                                                */
/* ------------------------------------------------------------------ */

export type MediaKind = "tape" | "heatshrink" | "flag" | "wrap";
export type LabelMedia = {
  id: string;
  name: string;
  kind: MediaKind;
  /** tape / tube print width across the tape (mm) */
  width: number;
  /** printable height across the tape (mm) */
  printable: number;
  /** Brother media type code for the raster "print information" command (0 = do not send) */
  brotherType: number;
  /** nominal width code sent to the printer (mm) */
  brotherWidth: number;
  /** wire diameter range (heat-shrink tubes) */
  wires?: string;
};

/** Brother P-touch media for wire marking (180 dpi PT printers: PT-E550W, PT-E560BT, PT-P750W, PT-P710BT, PT-P700, PT-D600 …) */
export const MEDIA: LabelMedia[] = [
  { id: "hse-211", name: "HSe-211 heat-shrink tube 5.8 mm", kind: "heatshrink", width: 5.8, printable: 3.9, brotherType: 0x11, brotherWidth: 6, wires: "Ø 1.7–5.0 mm" },
  { id: "hse-221", name: "HSe-221 heat-shrink tube 8.8 mm", kind: "heatshrink", width: 8.8, printable: 6.7, brotherType: 0x11, brotherWidth: 9, wires: "Ø 2.6–7.6 mm" },
  { id: "hse-231", name: "HSe-231 heat-shrink tube 11.7 mm", kind: "heatshrink", width: 11.7, printable: 9.3, brotherType: 0x11, brotherWidth: 12, wires: "Ø 3.6–10.4 mm" },
  { id: "hse-241", name: "HSe-241 heat-shrink tube 17.7 mm", kind: "heatshrink", width: 17.7, printable: 15.0, brotherType: 0x11, brotherWidth: 18, wires: "Ø 5.4–15.8 mm" },
  { id: "tze-6-flag", name: "TZe 6 mm tape — flag", kind: "flag", width: 6, printable: 4.5, brotherType: 0x01, brotherWidth: 6 },
  { id: "tze-9-flag", name: "TZe 9 mm tape — flag", kind: "flag", width: 9, printable: 7.0, brotherType: 0x01, brotherWidth: 9 },
  { id: "tze-12-flag", name: "TZe / TZe-FX 12 mm tape — flag", kind: "flag", width: 12, printable: 9.9, brotherType: 0x01, brotherWidth: 12 },
  { id: "tze-12-wrap", name: "TZe 12 mm tape — wrap around (repeated text)", kind: "wrap", width: 12, printable: 9.9, brotherType: 0x01, brotherWidth: 12 },
  { id: "tze-18-wrap", name: "TZe-SL 18 mm self-laminating — wrap", kind: "wrap", width: 18, printable: 15.8, brotherType: 0x01, brotherWidth: 18 },
  { id: "tze-9", name: "TZe 9 mm tape — straight", kind: "tape", width: 9, printable: 7.0, brotherType: 0x01, brotherWidth: 9 },
  { id: "tze-12", name: "TZe 12 mm tape — straight", kind: "tape", width: 12, printable: 9.9, brotherType: 0x01, brotherWidth: 12 },
  { id: "tze-18", name: "TZe 18 mm tape — straight", kind: "tape", width: 18, printable: 15.8, brotherType: 0x01, brotherWidth: 18 },
  { id: "tze-24", name: "TZe 24 mm tape — straight", kind: "tape", width: 24, printable: 18.0, brotherType: 0x01, brotherWidth: 24 },
];

export type LabelLayout = {
  media: LabelMedia;
  /** fixed label length (mm); 0 = fit the text */
  length: number;
  /** wire outer diameter (mm) — flag and wrap labels go around it */
  wireDiameter: number;
  /** how many times the text is repeated along a sleeve / wrap label */
  repeat: number;
  /** margin at both ends of the label (mm) */
  margin: number;
  /** flag labels: print the second half turned 180° (default: both halves the same way) */
  flagTurn?: boolean;
  /** longest automatic length (mm); longer text is made smaller */
  maxAuto?: number;
};

export type LabelItem = { text: string; x: number; y: number; size: number; bold: boolean; rot180?: boolean; maxWidth: number };
export type LaidLabel = { length: number; height: number; items: LabelItem[]; cutMarks: number[] };

export type Measure = (text: string, sizeMm: number, bold: boolean) => number;
/** rough Helvetica width (used without a canvas, e.g. in tests) */
export const approxMeasure: Measure = (t, s, b) => t.length * s * (b ? 0.62 : 0.56);

/**
 * Lay out one label. Coordinates in mm: x along the tape from the leading edge, y across the
 * printable height from the top; text positions are baselines.
 */
export function layoutLabel(r: LabelRecord, content: LabelContent, l: LabelLayout, measure: Measure = approxMeasure): LaidLabel {
  const H = l.media.printable;
  const detail = detailLine(r, content);
  const two = !!detail && H >= 6;
  // id line: as large as the height allows (two lines: 58 % of the height)
  let idSize = two ? H * 0.52 : H * 0.8;
  let dSize = two ? H * 0.3 : 0;
  const idW = (s: number) => measure(r.id || detail, s, true);
  const dW = (s: number) => (two ? measure(detail, s, false) : 0);
  const block = () => Math.max(idW(idSize), dW(dSize));
  const items: LabelItem[] = [];
  const place = (x0: number, w: number, rot180 = false) => {
    const mid = x0 + w / 2;
    if (two) {
      items.push({ text: r.id || "—", x: mid, y: H * 0.5, size: idSize, bold: true, rot180, maxWidth: w });
      items.push({ text: detail, x: mid, y: H * 0.5 + dSize * 1.15, size: dSize, bold: false, rot180, maxWidth: w });
    } else items.push({ text: r.id || detail || "—", x: mid, y: H / 2 + idSize * 0.36, size: idSize, bold: true, rot180, maxWidth: w });
  };
  const gap = Math.max(4, idSize * 1.2);
  const cut: number[] = [];
  if (l.media.kind === "flag") {
    // two halves read the same way after folding around the wire: the second half is turned 180°
    const wrap = Math.max(3, Math.PI * l.wireDiameter);
    let half = l.length ? (l.length - wrap) / 2 : Math.min(block() + 2 * l.margin, (l.maxAuto ?? 60) / 2);
    if (half < 4) half = 4;
    fit(half - 2 * l.margin);
    place(0, half);
    place(half + wrap, half, !!l.flagTurn);
    return { length: half * 2 + wrap, height: H, items, cutMarks: [half, half + wrap] };
  }
  if (l.media.kind === "wrap") {
    // text repeated so it can be read from any side of the wire
    const n = Math.max(2, l.repeat);
    const cell = Math.max(block() + gap, Math.PI * l.wireDiameter / n);
    const len = l.length || Math.min(cell * n + 2 * l.margin, l.maxAuto ?? 80);
    const c = (len - 2 * l.margin) / n;
    fit(c - gap * 0.5);
    for (let i = 0; i < n; i++) place(l.margin + i * c, c);
    return { length: len, height: H, items, cutMarks: cut };
  }
  // straight tape / heat-shrink sleeve: repeated `repeat` times along the label
  const n = Math.max(1, l.repeat);
  const len = l.length || Math.min(n * block() + (n - 1) * gap + 2 * l.margin, l.maxAuto ?? 60);
  const c = (len - 2 * l.margin + (n - 1) * 0) / n;
  fit(c - (n > 1 ? gap * 0.5 : 0));
  for (let i = 0; i < n; i++) place(l.margin + i * c, c);
  return { length: len, height: H, items, cutMarks: cut };

  /** shrink the text to fit a fixed length */
  function fit(w: number) {
    for (let k = 0; k < 30 && block() > w && idSize > 1.2; k++) {
      idSize *= 0.92;
      dSize *= 0.92;
    }
  }
}
