/**
 * Conductor information: insulation colours, cross-sections, circuit functions and cables, with the
 * conventions of the three common machine-wiring standards:
 *
 * - IEC 60204-1 (EU): black power, red AC control, blue DC control, orange excepted circuits,
 *   green-yellow PE, blue neutral; mains phases brown / black / grey (IEC 60445). Sizes in mm².
 * - NFPA 79 / UL 508A (US): black power, red AC control, blue DC control, orange excepted circuits,
 *   white (or grey) grounded AC, white-blue grounded DC, green (or green-yellow) equipment ground. AWG.
 * - JIS B 9960-1 (Japan, IEC 60204-1 adoption): black power, red AC control, blue DC control, orange
 *   excepted circuits, green-yellow PE; white neutral per Japanese practice. Sizes in "sq" (mm²).
 *
 * Colour codes are IEC 60757 (BK, BN, RD, …); NFPA drawings show the usual US abbreviations.
 */
import type { Cable, CableCore, Doc, Page, Wire, WireEnd, WireFunction, WirePot, WireUse, WiringSettings, WiringStandard } from "./model";

export const DEFAULT_WIRING: WiringSettings = { standard: "iec", showColor: true, showSection: true, tick: true, colorize: false, weightBySection: false };
export const wiringOf = (doc: Pick<Doc, "wiring">): WiringSettings => ({ ...DEFAULT_WIRING, ...(doc.wiring ?? {}) });

export const STANDARDS: Record<WiringStandard, { name: string; short: string; unit: "mm2" | "awg" | "sq" }> = {
  iec: { name: "IEC 60204-1 (Europe / international)", short: "IEC", unit: "mm2" },
  nfpa: { name: "NFPA 79 / UL 508A (North America)", short: "NFPA 79", unit: "awg" },
  jis: { name: "JIS B 9960-1 (Japan)", short: "JIS", unit: "sq" },
};

/* ------------------------------------------------------------------ */
/* Colours                                                              */
/* ------------------------------------------------------------------ */

export type WireColor = { code: string; name: string; hex: string; hex2?: string; us: string };

/** IEC 60757 codes. `hex2` = second colour of a two-colour insulation (drawn striped). */
export const COLORS: WireColor[] = [
  { code: "BK", name: "Black", hex: "#111111", us: "BLK" },
  { code: "BN", name: "Brown", hex: "#7b4a1e", us: "BRN" },
  { code: "RD", name: "Red", hex: "#d62828", us: "RED" },
  { code: "OG", name: "Orange", hex: "#f28c18", us: "ORG" },
  { code: "YE", name: "Yellow", hex: "#e6b800", us: "YEL" },
  { code: "GN", name: "Green", hex: "#1f8a3b", us: "GRN" },
  { code: "BU", name: "Blue", hex: "#1f5fd1", us: "BLU" },
  { code: "LBU", name: "Light blue", hex: "#4fa8e8", us: "LT BLU" },
  { code: "VT", name: "Violet", hex: "#7b3fb8", us: "VIO" },
  { code: "GY", name: "Grey", hex: "#7a7f87", us: "GRY" },
  { code: "WH", name: "White", hex: "#b8bcc4", us: "WHT" },
  { code: "PK", name: "Pink", hex: "#e05a9c", us: "PNK" },
  { code: "TQ", name: "Turquoise", hex: "#12a5a5", us: "TRQ" },
  { code: "GNYE", name: "Green-yellow", hex: "#1f8a3b", hex2: "#e6c200", us: "GRN/YEL" },
  { code: "WHBU", name: "White-blue", hex: "#b8bcc4", hex2: "#1f5fd1", us: "WHT/BLU" },
  { code: "WHRD", name: "White-red", hex: "#b8bcc4", hex2: "#d62828", us: "WHT/RED" },
];
const BY_CODE = new Map(COLORS.map((c) => [c.code, c]));

const ALIASES: Record<string, string> = {
  BLACK: "BK", BLK: "BK", NOIR: "BK", SCHWARZ: "BK", SW: "BK",
  BROWN: "BN", BRN: "BN", BR: "BN", MARRON: "BN", BRAUN: "BN",
  RED: "RD", RT: "RD", ROUGE: "RD", ROT: "RD",
  ORANGE: "OG", ORG: "OG", OR: "OG",
  YELLOW: "YE", YEL: "YE", YL: "YE", GE: "YE", GELB: "YE", JAUNE: "YE",
  GREEN: "GN", GRN: "GN", VERT: "GN", "GRÜN": "GN",
  BLUE: "BU", BLU: "BU", BL: "BU", BLEU: "BU", BLAU: "BU",
  "LIGHT BLUE": "LBU", "LT BLU": "LBU", "LT BLUE": "LBU", HBL: "LBU",
  VIOLET: "VT", VIO: "VT", PURPLE: "VT", VI: "VT",
  GREY: "GY", GRAY: "GY", GRY: "GY", GR: "GY", GRIS: "GY", GRAU: "GY",
  WHITE: "WH", WHT: "WH", WT: "WH", WS: "WH", BLANC: "WH", "WEISS": "WH", "WEIß": "WH",
  PINK: "PK", PNK: "PK", RS: "PK",
  TURQUOISE: "TQ", TRQ: "TQ",
  "GN/YE": "GNYE", "GN-YE": "GNYE", "GNYE": "GNYE", "GRN/YEL": "GNYE", "GREEN/YELLOW": "GNYE", "GREEN-YELLOW": "GNYE", "YE/GN": "GNYE", "GNGE": "GNYE", "GN/GE": "GNYE", PE: "GNYE",
  "WH/BU": "WHBU", "WHT/BLU": "WHBU", "WHITE/BLUE": "WHBU",
  "WH/RD": "WHRD", "WHT/RED": "WHRD",
};

/** Resolve any common spelling ("BK", "black", "BLK", "GN/YE") to a colour, or null. */
export function colorOf(value: string | undefined | null): WireColor | null {
  if (!value) return null;
  const k = value.trim().toUpperCase();
  const code = BY_CODE.has(k) ? k : ALIASES[k] ?? ALIASES[k.replace(/\s+/g, " ")];
  return (code && BY_CODE.get(code)) || null;
}

/** Text shown on the drawing for a colour, in the notation of the standard. */
export function colorLabel(value: string, std: WiringStandard): string {
  const c = colorOf(value);
  if (!c) return value.trim();
  if (std === "nfpa") return c.us;
  return c.hex2 ? `${c.code.slice(0, 2)}/${c.code.slice(2)}` : c.code;
}

/* ------------------------------------------------------------------ */
/* Functions & standard colours                                         */
/* ------------------------------------------------------------------ */

export const FUNCTIONS: { id: WireFunction; name: string }[] = [
  { id: "power", name: "Power (main circuit)" },
  { id: "L1", name: "Line L1" },
  { id: "L2", name: "Line L2" },
  { id: "L3", name: "Line L3" },
  { id: "N", name: "Neutral N" },
  { id: "PE", name: "Protective earth PE" },
  { id: "acControl", name: "AC control" },
  { id: "dcControl", name: "DC control (+)" },
  { id: "dc0V", name: "DC control 0 V" },
  { id: "interlock", name: "Interlock / external supply" },
  { id: "signal", name: "Signal / analog" },
];

const STD_COLORS: Record<WiringStandard, Record<WireFunction, string>> = {
  iec: { power: "BK", L1: "BN", L2: "BK", L3: "GY", N: "LBU", PE: "GNYE", acControl: "RD", dcControl: "BU", dc0V: "BU", interlock: "OG", signal: "VT" },
  nfpa: { power: "BK", L1: "BK", L2: "BK", L3: "BK", N: "WH", PE: "GN", acControl: "RD", dcControl: "BU", dc0V: "WHBU", interlock: "OG", signal: "VT" },
  jis: { power: "BK", L1: "BK", L2: "BK", L3: "BK", N: "WH", PE: "GNYE", acControl: "RD", dcControl: "BU", dc0V: "BU", interlock: "OG", signal: "VT" },
};

export const standardColor = (fn: WireFunction | undefined, std: WiringStandard): string | undefined => (fn ? STD_COLORS[std][fn] : undefined);

/* ------------------------------------------------------------------ */
/* Potential + use (the conductor's circuit role)                       */
/* ------------------------------------------------------------------ */

export const WIRE_POTS: { id: WirePot; name: string; short: string }[] = [
  { id: "L1", name: "L1 — phase 1", short: "L1" },
  { id: "L2", name: "L2 — phase 2", short: "L2" },
  { id: "L3", name: "L3 — phase 3", short: "L3" },
  { id: "L", name: "L — AC phase", short: "L" },
  { id: "N", name: "N — neutral", short: "N" },
  { id: "DC+", name: "+V (DC positive)", short: "+V" },
  { id: "DC0", name: "0 V / GND (DC return)", short: "0 V" },
  { id: "DC-", name: "−V (negative supply, e.g. −15 V — not GND)", short: "−V" },
  { id: "PE", name: "PE — protective earth", short: "PE" },
  { id: "signal", name: "Signal / data", short: "Signal" },
];
export const WIRE_USES: { id: WireUse; name: string; hint: string }[] = [
  { id: "power", name: "Power", hint: "Main / load circuit — black" },
  { id: "control", name: "Control", hint: "Control circuit — red (AC) / blue (DC)" },
  { id: "external", name: "External supply", hint: "Interlock circuit fed from outside, live with the main switch off — orange" },
];

/** what a pre-2026-10 "function" meant */
export function legacyCircuit(fn: WireFunction | undefined): { pot?: WirePot; use?: WireUse } {
  switch (fn) {
    case "power":
      return { use: "power" };
    case "L1":
    case "L2":
    case "L3":
    case "N":
      return { pot: fn, use: "power" };
    case "PE":
      return { pot: "PE" };
    case "acControl":
      return { pot: "L", use: "control" };
    case "dcControl":
      return { pot: "DC+", use: "control" };
    case "dc0V":
      return { pot: "DC0", use: "control" };
    case "interlock":
      return { use: "external" };
    case "signal":
      return { pot: "signal" };
    default:
      return {};
  }
}
/** potential set on the wire (or implied by its legacy function); undefined = automatic */
export const wirePot = (w: Pick<Wire, "pot" | "fn">): WirePot | undefined => w.pot ?? legacyCircuit(w.fn).pot;
/** use set on the wire (or implied by its legacy function); undefined = the supply's default */
export const wireUse = (w: Pick<Wire, "use" | "fn">): WireUse | undefined => w.use ?? legacyCircuit(w.fn).use;

/**
 * Standard insulation colour for a potential + use (IEC 60204-1 13.2.4 / NFPA 79 16.2 / JIS B 9960-1):
 * PE green-yellow; N light blue (white in NFPA / JIS); external supplies orange; phases of power
 * circuits brown / black / grey (IEC 60445) or black; AC control red; DC control blue; power black;
 * NFPA grounded DC (0 V) white-blue; signal violet (house convention).
 */
export function standardColorFor(pot: WirePot | undefined, use: WireUse | undefined, std: WiringStandard, kind?: "ac" | "dc" | "signal" | "any"): string | undefined {
  if (pot === "PE") return std === "nfpa" ? "GN" : "GNYE";
  if (pot === "N") return std === "iec" ? "LBU" : "WH";
  if (pot === "signal" || kind === "signal") return "VT";
  if (use === "external") return "OG";
  const ac = pot === "L" || pot === "L1" || pot === "L2" || pot === "L3" ? true : pot ? false : kind === "ac" ? true : kind === "dc" ? false : undefined;
  if (pot === "DC0" && std === "nfpa") return "WHBU";
  if (use === "power" || (use === undefined && (pot === "L1" || pot === "L2" || pot === "L3"))) {
    if (std === "iec" && pot === "L1") return "BN";
    if (std === "iec" && pot === "L3") return "GY";
    return "BK";
  }
  if (use === "control") return ac === undefined ? undefined : ac ? "RD" : "BU";
  return undefined;
}

/** the legacy function id for a potential + use (QElectroTech "function" text, wire lists) */
export function functionFor(pot: WirePot | undefined, use: WireUse | undefined): WireFunction | undefined {
  if (pot === "PE") return "PE";
  if (pot === "signal") return "signal";
  if (use === "external") return "interlock";
  if (pot === "L1" || pot === "L2" || pot === "L3" || pot === "N") return use === "control" ? "acControl" : pot;
  if (pot === "DC0") return use === "power" ? "power" : "dc0V";
  if (pot === "DC+" || pot === "DC-") return use === "power" ? "power" : "dcControl";
  if (pot === "L") return use === "power" ? "power" : use === "control" ? "acControl" : undefined;
  return use === "power" ? "power" : undefined;
}

/** "0 V · Control", "L1 · Power", "PE" */
export function circuitText(pot: WirePot | undefined, use: WireUse | undefined): string {
  const p = pot ? WIRE_POTS.find((x) => x.id === pot)?.short : undefined;
  const u = use && pot !== "PE" && pot !== "signal" ? WIRE_USES.find((x) => x.id === use)?.name : undefined;
  return [p, u].filter(Boolean).join(" · ");
}

/** QET stores the function as free text: accept our ids and names. */
export function functionOf(text: string | undefined): WireFunction | undefined {
  if (!text) return undefined;
  const t = text.trim().toLowerCase();
  return FUNCTIONS.find((f) => f.id.toLowerCase() === t || f.name.toLowerCase() === t)?.id;
}

/* ------------------------------------------------------------------ */
/* Cross-sections                                                       */
/* ------------------------------------------------------------------ */

export const MM2_SIZES = [0.14, 0.25, 0.34, 0.5, 0.75, 1, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240];
/** Japanese stranded wire (KIV / IV) nominal sizes */
export const SQ_SIZES = [0.3, 0.5, 0.75, 1.25, 2, 3.5, 5.5, 8, 14, 22, 38, 60, 100, 150, 200];
export const AWG_SIZES: { awg: string; mm2: number }[] = [
  { awg: "26", mm2: 0.129 }, { awg: "24", mm2: 0.205 }, { awg: "22", mm2: 0.326 }, { awg: "20", mm2: 0.518 }, { awg: "18", mm2: 0.823 },
  { awg: "16", mm2: 1.31 }, { awg: "14", mm2: 2.08 }, { awg: "12", mm2: 3.31 }, { awg: "10", mm2: 5.26 }, { awg: "8", mm2: 8.37 },
  { awg: "6", mm2: 13.3 }, { awg: "4", mm2: 21.2 }, { awg: "3", mm2: 26.7 }, { awg: "2", mm2: 33.6 }, { awg: "1", mm2: 42.4 },
  { awg: "1/0", mm2: 53.5 }, { awg: "2/0", mm2: 67.4 }, { awg: "3/0", mm2: 85 }, { awg: "4/0", mm2: 107 },
];

const fmtNum = (n: number) => String(n).replace(/\.0+$/, "");

/** Standard size choices for a standard, as display strings. */
export function sectionChoices(std: WiringStandard): string[] {
  const u = STANDARDS[std].unit;
  if (u === "awg") return AWG_SIZES.map((a) => `${a.awg} AWG`);
  if (u === "sq") return SQ_SIZES.map((n) => `${fmtNum(n)} sq`);
  return MM2_SIZES.map((n) => `${fmtNum(n)} mm²`);
}

/** Cross-section in mm² from any common notation ("1.5", "1,5 mm2", "1.5 sqmm", "16 AWG", "1.25sq"). */
export function sectionMm2(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase().replace(",", ".");
  const awg = /^(\d+(?:\/0)?)\s*awg$/.exec(t) ?? /^awg\s*(\d+(?:\/0)?)$/.exec(t);
  if (awg) return AWG_SIZES.find((a) => a.awg === awg[1])?.mm2 ?? null;
  const m = /^(\d+(?:\.\d+)?)\s*(mm²|mm2|sqmm|sq\.?\s*mm|sq|mm)?$/.exec(t);
  return m ? Number(m[1]) : null;
}

/** Line weight factor for a cross-section (1 = the normal wire weight). */
export function sectionWeight(s: string | undefined): number {
  const a = sectionMm2(s);
  if (a === null) return 1;
  if (a <= 0.75) return 0.8;
  if (a <= 1.5) return 1;
  if (a <= 2.5) return 1.3;
  if (a <= 6) return 1.6;
  if (a <= 16) return 2;
  if (a <= 35) return 2.5;
  return 3;
}

/* ------------------------------------------------------------------ */
/* Cables                                                               */
/* ------------------------------------------------------------------ */

/** HD 308 S2 / VDE core colours of flexible power cables ("G" = with green-yellow core). */
const HD308: Record<number, string[]> = {
  1: ["BK"],
  2: ["BN", "BU"],
  3: ["BN", "BK", "GY"],
  4: ["BN", "BK", "GY", "BU"],
  5: ["BN", "BK", "GY", "BU", "BK"],
};
const HD308G: Record<number, string[]> = {
  3: ["BN", "BU", "GNYE"],
  4: ["BN", "BK", "GY", "GNYE"],
  5: ["BN", "BK", "GY", "BU", "GNYE"],
};
/** DIN 47100 colour code of multi-core control / data cables (first 12). */
const DIN47100 = ["WH", "BN", "GN", "YE", "GY", "PK", "BU", "RD", "BK", "VT", "GYPK", "RDBU"];

export type CoreScheme = "colors" | "numbered" | "din47100";

/** Core list for a new cable: n cores, optionally one of them green-yellow (the "G" in 4G1.5). */
export function makeCores(n: number, scheme: CoreScheme, earth: boolean): CableCore[] {
  if (scheme === "colors" && n <= 5) {
    const list = earth ? HD308G[n] ?? [...(HD308[n - 1] ?? []), "GNYE"] : HD308[n];
    if (list) return list.map((c, i) => ({ name: list.indexOf(c) === i ? c : `${c}${list.slice(0, i).filter((x) => x === c).length + 1}`, color: c }));
  }
  if (scheme === "din47100" && n <= DIN47100.length) return DIN47100.slice(0, n).map((c) => ({ name: c, color: colorOf(c) ? c : undefined }));
  // numbered black cores (+ green-yellow earth last)
  const count = earth ? n - 1 : n;
  const out: CableCore[] = Array.from({ length: Math.max(0, count) }, (_, i) => ({ name: String(i + 1), color: "BK" }));
  if (earth) out.push({ name: "GNYE", color: "GNYE" });
  return out;
}

/** Common cable designation like "4G1.5" / "3x2.5" / "12x0.25". */
export function cableDesignation(c: Pick<Cable, "cores" | "section">): string {
  const n = c.cores.length;
  const g = c.cores.some((k) => colorOf(k.color ?? k.name)?.code === "GNYE");
  const a = sectionMm2(c.section);
  return a !== null ? `${n}${g ? "G" : "x"}${fmtNum(a)}` : `${n} cores`;
}

export const cableByTag = (doc: Pick<Doc, "cables">, tag: string | undefined): Cable | undefined => (tag ? doc.cables?.find((c) => c.tag === tag) : undefined);

/** Next free cable tag ("W1", "W2", …). */
export function nextCableTag(doc: Pick<Doc, "cables" | "pages">): string {
  const used = new Set<string>([...(doc.cables ?? []).map((c) => c.tag), ...doc.pages.flatMap((p) => p.wires.map((w) => w.cable ?? ""))]);
  for (let i = 1; ; i++) if (!used.has(`W${i}`)) return `W${i}`;
}

/* ------------------------------------------------------------------ */
/* Effective conductor information                                      */
/* ------------------------------------------------------------------ */

export type WireInfo = {
  /** effective insulation colour code as written (explicit > cable core > standard for the function) */
  color?: string;
  colorSource?: "wire" | "core" | "standard";
  look: WireColor | null;
  section?: string;
  cable?: Cable;
  core?: string;
};

export function wireInfo(doc: Pick<Doc, "wiring" | "cables">, w: Wire): WireInfo {
  const std = wiringOf(doc).standard;
  const cable = cableByTag(doc, w.cable);
  const core = w.core && cable ? cable.cores.find((k) => k.name === w.core) : undefined;
  let color: string | undefined, colorSource: WireInfo["colorSource"];
  if (w.insulation?.trim()) (color = w.insulation.trim()), (colorSource = "wire");
  else if (core?.color) (color = core.color), (colorSource = "core");
  else {
    const sc = standardColorFor(wirePot(w), wireUse(w), std);
    if (sc) (color = sc), (colorSource = "standard");
  }
  return { color, colorSource, look: colorOf(color), section: w.section?.trim() || cable?.section || undefined, cable, core: w.core };
}

/** Annotation text for the drawing ("BK 1.5 mm²", "W1:3 1.5 mm²"). */
export function wireAnnotation(doc: Pick<Doc, "wiring" | "cables">, w: Wire): string {
  const s = wiringOf(doc);
  const i = wireInfo(doc, w);
  const parts: string[] = [];
  if (s.showColor) {
    if (i.cable && i.core) {
      // cable core: its colour if it is named by colour, else "core number [colour]"
      if (colorOf(i.core)) parts.push(colorLabel(i.core, s.standard));
      else parts.push(i.color && i.colorSource === "wire" ? `${i.core} ${colorLabel(i.color, s.standard)}` : i.core);
    } else if (i.color) parts.push(colorLabel(i.color, s.standard));
  }
  if (s.showSection && i.section && !(i.cable && i.cable.section && !w.section)) parts.push(i.section);
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Cable marks (drawn where a cable's wires run side by side)           */
/* ------------------------------------------------------------------ */

export type CableMark = { tag: string; a: { x: number; y: number }; b: { x: number; y: number }; horizontal: boolean; label: string; shield: boolean; wires: string[]; /** shared run along the wires where the mark can sit */ lo: number; hi: number; /** dragged label, offset from the mark centre */ labelOffset?: { x: number; y: number } };

/**
 * Where to draw each cable on a page: a short line crossing the parallel run shared by most of the
 * cable's wires (horizontal or vertical), like the cable definition line of common CAE tools.
 */
const markCache = new WeakMap<Wire[], { cables: unknown; marks: CableMark[] }>();
export function cableMarks(doc: Pick<Doc, "cables" | "wiring">, page: Page): CableMark[] {
  const c = markCache.get(page.wires);
  if (c && c.cables === doc.cables) return c.marks;
  const marks = computeCableMarks(doc, page);
  markCache.set(page.wires, { cables: doc.cables, marks });
  return marks;
}
export function computeCableMarks(doc: Pick<Doc, "cables" | "wiring">, page: Page): CableMark[] {
  const byTag = new Map<string, Wire[]>();
  for (const w of page.wires) if (w.cable) (byTag.get(w.cable) ?? byTag.set(w.cable, []).get(w.cable)!).push(w);
  const out: CableMark[] = [];
  for (const [tag, wires] of byTag) {
    const cable = cableByTag(doc, tag);
    const label = cable ? [tag, cable.type || cableDesignation(cable)].filter(Boolean).join(" · ") : tag;
    const h = bestCrossing(wires, "h"), v = bestCrossing(wires, "v");
    // more wires first, then the longer shared straight run
    const best = !h ? v : !v ? h : v.ids.length !== h.ids.length ? (v.ids.length > h.ids.length ? v : h) : v.run > h.run ? v : h;
    if (!best) continue;
    const ov = cable?.marks?.[page.id];
    if (ov?.at !== undefined) best.pos = Math.min(Math.max(ov.at, best.lo), best.hi);
    const pad = 6;
    const lo = Math.min(...best.at) - pad, hi = Math.max(...best.at) + pad;
    const mark: CableMark = best.axis === "h"
      ? { tag, a: { x: best.pos - 3, y: lo }, b: { x: best.pos + 3, y: hi }, horizontal: true, label, shield: !!cable?.shield, wires: best.ids, lo: best.lo, hi: best.hi }
      : { tag, a: { x: lo, y: best.pos + 3 }, b: { x: hi, y: best.pos - 3 }, horizontal: false, label, shield: !!cable?.shield, wires: best.ids, lo: best.lo, hi: best.hi };
    if (ov?.label) mark.labelOffset = ov.label;
    out.push(mark);
  }
  return out;
}

/** Find the coordinate along `axis` ("h" = horizontal segments) crossed by the most wires of the cable. */
function bestCrossing(wires: Wire[], axis: "h" | "v"): { axis: "h" | "v"; pos: number; at: number[]; ids: string[]; run: number; lo: number; hi: number } | null {
  type Seg = { id: string; lo: number; hi: number; at: number };
  const segs: Seg[] = [];
  for (const w of wires)
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      if (axis === "h" && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.x - b.x) > 8) segs.push({ id: w.id, lo: Math.min(a.x, b.x) + 4, hi: Math.max(a.x, b.x) - 4, at: a.y });
      if (axis === "v" && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) > 8) segs.push({ id: w.id, lo: Math.min(a.y, b.y) + 4, hi: Math.max(a.y, b.y) - 4, at: a.x });
    }
  if (!segs.length) return null;
  // candidate positions: segment ends and midpoints
  const cands = new Set<number>();
  for (const s of segs) cands.add(s.lo), cands.add(s.hi), cands.add((s.lo + s.hi) / 2);
  let best: { pos: number; ids: string[]; at: number[]; score: number } | null = null;
  for (const c of cands) {
    const hit = segs.filter((s) => c >= s.lo && c <= s.hi);
    const ids = [...new Set(hit.map((s) => s.id))];
    if (!ids.length) continue;
    const at = ids.map((id) => hit.find((s) => s.id === id)!.at);
    // prefer more wires, then a tight bundle, then the middle of the shared run
    const spread = Math.max(...at) - Math.min(...at);
    const shared = hit.reduce((m, s) => Math.min(m, s.hi - c, c - s.lo), Infinity);
    const score = ids.length * 1000 - spread + Math.min(shared, 200) * 0.5;
    if (!best || score > best.score) best = { pos: c, ids, at, score };
  }
  if (!best) return null;
  // centre on the common overlap of the chosen wires
  const chosen = segs.filter((s) => best!.ids.includes(s.id) && best!.pos >= s.lo && best!.pos <= s.hi);
  const lo = Math.max(...chosen.map((s) => s.lo)), hi = Math.min(...chosen.map((s) => s.hi));
  const pos = lo <= hi ? Math.round(((lo + hi) / 2) / 5) * 5 : best.pos;
  return { axis, pos: Math.min(Math.max(pos, lo), hi) || pos, at: best.at, ids: best.ids, run: Math.max(0, hi - lo), lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

/** Auto-assign free cores of a cable to wires, in drawing order (top→bottom, then left→right). */
export function assignCores(doc: Pick<Doc, "cables" | "pages">, cable: Cable, wires: Wire[]): void {
  const used = new Set(doc.pages.flatMap((p) => p.wires.filter((w) => w.cable === cable.tag && w.core && !wires.includes(w)).map((w) => w.core!)));
  const order = [...wires].sort((a, b) => a.pts[0].y - b.pts[0].y || a.pts[0].x - b.pts[0].x);
  const free = cable.cores.map((c) => c.name).filter((n) => !used.has(n));
  // keep the green-yellow core for PE wires
  const isEarthCore = (n: string) => colorOf(cable.cores.find((c) => c.name === n)?.color ?? n)?.code === "GNYE";
  for (const w of order) {
    w.cable = cable.tag;
    const wantsEarth = wirePot(w) === "PE" || colorOf(w.insulation)?.code === "GNYE";
    const pick = free.find((n) => isEarthCore(n) === wantsEarth) ?? (wantsEarth ? undefined : free.find((n) => !isEarthCore(n)));
    if (pick) {
      w.core = pick;
      free.splice(free.indexOf(pick), 1);
    } else w.core = undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Wire ends                                                            */
/* ------------------------------------------------------------------ */

/** Address of a wire end: component reference and pin ("X1:8"), or null for junctions / open ends. */
export function endAddress(doc: Pick<Doc, "defs">, page: Page, end: WireEnd): string | null {
  if (end.k !== "pin") return null;
  const e = elementsById(page).get(end.el);
  if (!e) return null;
  const pin = doc.defs[e.defId]?.pins.find((p) => p.id === end.pin);
  const ref = e.info.label || doc.defs[e.defId]?.name || "?";
  const p = pin?.number || pin?.name;
  return p ? `${ref}:${p}` : ref;
}

/**
 * Text written at one end of a wire. A manual end name wins; otherwise the wire number (when
 * numbers are placed at the ends) and/or the address of the far end ("destination" marking).
 */
export function wireEndLabel(doc: Pick<Doc, "defs">, page: Page, w: Wire, end: "a" | "b", numberAtEnds: boolean, destination: boolean): string {
  const manual = w.endLabels?.[end];
  if (manual !== undefined && manual !== "") return manual;
  const parts: string[] = [];
  if (numberAtEnds && w.label) parts.push(w.label);
  if (destination) {
    const far = endAddress(doc, page, end === "a" ? w.b : w.a);
    if (far) parts.push(far);
  }
  return parts.join(" / ");
}

const elIdx = new WeakMap<object, Map<string, Page["elements"][number]>>();
function elementsById(page: Page) {
  let m = elIdx.get(page.elements);
  if (!m) elIdx.set(page.elements, (m = new Map(page.elements.map((e) => [e.id, e]))));
  return m;
}
