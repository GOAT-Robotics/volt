/**
 * Volt document model. Isomorphic (browser + server), JSON-serialisable.
 * Coordinates are QElectroTech scene units (1 unit = 1 px at 100% zoom; grid 10).
 */
import type { SigRef } from "./signals";

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/* ------------------------------------------------------------------ */
/* Element definitions (QET .elmt)                                     */
/* ------------------------------------------------------------------ */

export type Orient = "n" | "e" | "s" | "w";

/** QET primitive style string parsed. */
export type PrimStyle = {
  lineStyle: "normal" | "dashed" | "dotted" | "dashdotted";
  lineWeight: "none" | "thin" | "normal" | "hight" | "eleve";
  filling: string; // none | black | white | <color> | hor | ver | bdiag | fdiag
  color: string; // black | white | red | ... | none
};

export type LineEnd = "none" | "simple" | "triangle" | "circle" | "diamond";

export type Prim =
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; end1: LineEnd; end2: LineEnd; len1: number; len2: number; style: PrimStyle }
  | { t: "rect"; x: number; y: number; w: number; h: number; rx: number; ry: number; style: PrimStyle }
  | { t: "ellipse"; x: number; y: number; w: number; h: number; style: PrimStyle }
  | { t: "arc"; x: number; y: number; w: number; h: number; start: number; angle: number; style: PrimStyle }
  | { t: "polygon"; pts: Pt[]; closed: boolean; style: PrimStyle }
  | { t: "text"; x: number; y: number; text: string; size: number; rotation: number; color: string; font?: string }
  | {
      t: "dyntext";
      x: number;
      y: number;
      /** ElementInfo (info_name), UserText (text), CompositeText */
      from: "ElementInfo" | "UserText" | "CompositeText";
      info?: string;
      text: string;
      size: number;
      rotation: number;
      halign: "left" | "center" | "right";
      valign: "top" | "center" | "bottom";
      frame: boolean;
      width: number;
      uuid?: string;
      color?: string;
    };

export type PinDef = {
  id: string; // QET terminal uuid (or synthetic)
  x: number;
  y: number;
  orient: Orient;
  name: string;
  number: string;
  type: string; // Generic | Inner | Outer
  required?: boolean;
  /**
   * What the pin carries, for connection checks and wire classes: L / L1–L3 (AC phase), N, PE,
   * DC+ / DC0 (0 V) / DC− and signal; "none" = deliberately unclassified (pass-through).
   * Unset = inferred from the pin name ("L", "N", "PE", "+V", "0V" …).
   */
  cls?: PinClass;
  /** nominal voltage for DC+ / DC− / L pins (24 for a 24 V output) */
  volts?: number;
  /** signal pins: bus and line (CAN H, RS-485 A, UART TX …); unset = recognised from the name */
  sig?: SigRef;
};

export type PinClass = "L" | "L1" | "L2" | "L3" | "N" | "PE" | "DC+" | "DC0" | "DC-" | "signal" | "none";
export const PIN_CLASSES: { id: PinClass; label: string; hint: string }[] = [
  { id: "L", label: "L — AC phase", hint: "Line / phase of single-phase AC" },
  { id: "L1", label: "L1 — phase 1", hint: "Three-phase L1" },
  { id: "L2", label: "L2 — phase 2", hint: "Three-phase L2" },
  { id: "L3", label: "L3 — phase 3", hint: "Three-phase L3" },
  { id: "N", label: "N — neutral", hint: "AC neutral" },
  { id: "PE", label: "PE — protective earth", hint: "Protective earth / FG" },
  { id: "DC+", label: "DC+ — positive", hint: "+V, +24 V …" },
  { id: "DC0", label: "0 V / GND — DC return", hint: "−V output of a supply, 0 V, GND, M" },
  { id: "DC-", label: "−V — negative supply (not GND)", hint: "A negative voltage (−15 V), not 0 V / GND" },
  { id: "signal", label: "Signal / data", hint: "I/O, CAN, RS-485, encoder … must not meet power" },
  { id: "none", label: "None (any)", hint: "Pass-through: terminals, contacts, fuses" },
];

export type ElementDef = {
  id: string; // stable key: library path or uuid
  uuid: string;
  name: string;
  names: Record<string, string>;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  linkType: string;
  prefix: string;
  category: string;
  prims: Prim[];
  pins: PinDef[];
  info: Record<string, string>; // elementInformations defaults
  kind: Record<string, string>; // kindInformations
  meta: Record<string, string>; // manufacturer, part number, description ...
  /** Original XML (for lossless preservation of unknown nodes). */
  xml?: string;
  /** Library provenance */
  source?: { libraryElementId?: string; revision?: number; path?: string; status?: string };
  placeholder?: boolean; // definition missing (e.g. common://), drawn as box
};

/* ------------------------------------------------------------------ */
/* Styles                                                               */
/* ------------------------------------------------------------------ */

export const TEXT_ROLES = [
  "componentName",
  "componentRating",
  "componentPartNumber",
  "componentManufacturer",
  "componentRef",
  "connectorName",
  "pinNumber",
  "pinName",
  "wireLabel",
  "wireInfo",
  "cableLabel",
  "terminalLabel",
  "annotation",
  "pageTitle",
  "titleBlockField",
  "revisionTable",
] as const;
export type TextRole = (typeof TEXT_ROLES)[number];

export type TextStyle = {
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  background: string | null; // mask color or null
  align: "left" | "center" | "right";
  rotation: number;
  dx: number; // anchor offset
  dy: number;
  lineHeight: number;
  visible: boolean;
};

export const COMPONENT_INFO = [
  { key: "description", name: "Name", role: "componentName" },
  { key: "rating", name: "Rating", role: "componentRating" },
  { key: "manufacturer_reference", name: "Part number", role: "componentPartNumber" },
  { key: "manufacturer", name: "Manufacturer", role: "componentManufacturer" },
] as const;
/** Where the component info block sits: under the reference (moving beside the symbol if needed), or fixed. */
export type InfoPlacement = "auto" | "right" | "left" | "below" | "free";
/** `pos` (with at = "free"): top-left of the block in element coordinates, so it follows the component. */
export type InfoLayout = { at?: InfoPlacement; align?: "left" | "center" | "right"; pos?: Pt };
export type ComponentInfoKey = (typeof COMPONENT_INFO)[number]["key"];
export type ComponentInfoFlags = Partial<Record<ComponentInfoKey, boolean>>;

export type LineStyle = { color: string; width: number; dash: "solid" | "dashed" | "dotted" | "dashdot" };
/** box around a component: line style + gap between the symbol and the box */
export type ComponentFrame = LineStyle & { show: boolean; padding: number };

export type GraphicStyles = {
  wire: LineStyle & { junctionRadius: number; junctionColor: string; highlight: string };
  bus: LineStyle;
  pin: { color: string; size: number; showPoint: boolean };
  /** symbol lines: force one colour for every symbol, scale their thickness */
  outline: { color: string | null; widthScale: number };
  /** component outline: a box drawn around each component's symbol (off by default) */
  frame?: ComponentFrame;
  /** which component information lines are shown under the reference by default */
  componentInfo?: ComponentInfoFlags;
  /** default placement of the component info block */
  componentInfoLayout?: InfoLayout;
  border: LineStyle & { headerColor: string; font: string; size: number };
  titleBlock: LineStyle & { font: string };
  selection: string;
  review: { added: string; removed: string; changed: string; comment: string };
};

export type Styles = { text: Record<TextRole, TextStyle>; graphics: GraphicStyles };
export type PartialStyles = {
  text?: Partial<Record<TextRole, Partial<TextStyle>>>;
  graphics?: DeepPartial<GraphicStyles>;
};
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/* ------------------------------------------------------------------ */
/* Diagram content                                                      */
/* ------------------------------------------------------------------ */

export type PlacedText = {
  id: string;
  role: TextRole;
  /** ElementInfo name ("label", "comment", ...) or null for literal text */
  info: string | null;
  text: string; // literal (for info==null)
  /** local position relative to element hotspot (before rotation) — null = default anchor from style */
  x: number | null;
  y: number | null;
  override?: Partial<TextStyle>;
  uuid?: string; // QET dynamic text uuid
  /** fixed page rotation in degrees (0 horizontal, 90 vertical), independent of the component's rotation; unset = follows the component */
  rotation?: number;
};

export type ElemInst = {
  id: string; // QET uuid without braces
  defId: string;
  x: number;
  y: number;
  rot: 0 | 1 | 2 | 3; // ×90° clockwise
  mirror: boolean;
  /** uniform size factor (aspect ratio kept); unset = 1 */
  scale?: number;
  /** elementInformations (label, comment, function, manufacturer, ...) */
  info: Record<string, string>;
  texts: PlacedText[];
  refLocked?: boolean;
  locked?: boolean;
  hidden?: boolean;
  z?: number;
  showPinNumbers?: boolean;
  showPinNames?: boolean;
  /** show / hide the component information lines (name, rating, part number, manufacturer); unset = project default */
  showInfo?: ComponentInfoFlags;
  /** placement / alignment of the info block for this component; unset = project default */
  infoLayout?: InfoLayout;
  /** symbol line colour for this component (overrides "Symbol lines") */
  outlineOverride?: Partial<LineStyle>;
  /** outline box around this component (overrides the project "Component outline") */
  frame?: Partial<ComponentFrame>;
  group?: GroupRef;
  /** QElectroTech cross-reference links (folio report pairs, master ↔ slaves): ids of linked elements */
  links?: string[];
  /** mated connector: the counterpart (plug ↔ socket) and this side's gender; pins connect by number */
  /**
   * mated connector: the counterpart and this side's gender. `label` = the "▸ counterpart" text on the
   * drawing: auto (only when the counterpart is on another sheet or far away), show or hide;
   * `labelPos` = where it was dragged, relative to the component origin.
   */
  mate?: { id: string; gender: "male" | "female"; label?: "auto" | "show" | "hide"; labelPos?: Pt };
  qet?: { idx?: number; terminalIds?: Record<string, string> }; // original node index; pinId -> original terminal id
};

export type GroupRef = {
  id: string; // instance id (shared by every item of one placed block)
  blockId: string; // library element id of the block
  revision: number;
  mode: "linked" | "independent" | "derived";
  name: string;
  origin?: Pt; // placement origin (block bbox top-left)
  src?: string; // id of the corresponding item inside the block definition
};

export type WireEnd =
  | { k: "pin"; el: string; pin: string }
  | { k: "junction"; j: string }
  | { k: "free" };

export type Wire = {
  id: string;
  a: WireEnd;
  b: WireEnd;
  /** polyline, including both endpoints */
  pts: Pt[];
  label?: string; // conductor number / wire label
  labelPos?: number; // 0..1 along wire, default 0.5
  /** cable tag (e.g. "W1") this conductor is a core of */
  cable?: string;
  /** core designation inside the cable ("1", "BN", …) */
  core?: string;
  /**
   * Potential the conductor carries (same list as pin classes): L / L1–L3 / N, DC + / 0 V / −,
   * PE or signal. Unset = detected from rails, pins and the supply. With `use` it gives the
   * standard insulation colour; 0 V and N make the wire number a return (…N).
   */
  pot?: WirePot;
  /** what the circuit is for: power, control, or an external / interlock supply (orange). Unset = the supply's default */
  use?: WireUse;
  /** @deprecated pre-2026-10 "function"; read through wirePot / wireUse, never written */
  fn?: WireFunction;
  /** insulation colour code as entered (IEC 60757 "BK", "GNYE", or e.g. "BLK", "black") */
  insulation?: string;
  /** conductor cross-section as entered ("1.5 mm²", "16 AWG", "1.25 sq") */
  section?: string;
  /** names written at each end of the wire (wire markers); override the automatic end marking */
  endLabels?: { a?: string; b?: string };
  bus?: boolean;
  override?: Partial<LineStyle>;
  group?: GroupRef;
  /** wire number set by hand: automatic wire numbering never changes it */
  labelLocked?: boolean;
  /** supply (id of a WireClass, "__pe" = protective earth) this conductor belongs to; unset = detected. Gives the wire-number letter */
  vclass?: string;
  qet?: { idx?: number; attrs?: Record<string, string> };
};

/**
 * A class of circuits for automatic wire numbering: the identifier's leading letter(s) tell the
 * voltage system at a glance (e.g. A = 48 V DC, B = 24 V DC, C = 5 V DC). kind/volts drive detection
 * from rail names, conductor functions and pin names; `match` (regex) catches signal names (CAN_H …).
 */
/**
 * A supply (voltage system) of the project: its wire-number letter, AC / DC / signal, nominal
 * voltage, and the default use of its conductors (power → black, control → red AC / blue DC).
 */
export type WireClass = { id: string; letter: string; name: string; kind: "dc" | "ac" | "signal" | "any"; volts?: number; match?: string; use?: "power" | "control" };
export type WirePot = Exclude<PinClass, "none">;
export type WireUse = "power" | "control" | "external";

/** Automatic wire numbering (Volt-only, stored with the project). */
export type WireNumbering = {
  preset: "harness" | "panel" | "custom";
  /** tokens: {class} {n} {n:3} {seg} {ret} {page} {col} {row} {size} */
  format: string;
  /** every physical wire segment (terminal to terminal, splice to splice) gets its own segment letter */
  segments: boolean;
  /** appended to return conductors (0 V, GND, N) — "N" as in SAE AS50881 */
  returnSuffix: string;
  /** class letters for protective earth and for circuits whose voltage cannot be determined */
  peLetter: string;
  /**
   * How 0 V / GND conductors are numbered: "return" = as the return of their supply (B013AN, the
   * default); "letter" = one common ground letter for every DC return (G013A), for panels where all
   * 0 V are bonded together.
   */
  gndMode?: "return" | "letter";
  /** the common ground letter when gndMode is "letter" */
  gndLetter?: string;
  fallbackLetter: string;
  classes: WireClass[];
  /** class used for DC / AC conductors of unknown voltage */
  defaultDc?: string;
  defaultAc?: string;
  start: number;
  /** overwrite rail names (L1, N, +24V, 0V) with numbers — the potential is kept as the conductor function / class */
  replacePotentialNames: boolean;
};

export type WireFunction = "power" | "L1" | "L2" | "L3" | "N" | "PE" | "acControl" | "dcControl" | "dc0V" | "interlock" | "signal";
export type WiringStandard = "iec" | "nfpa" | "jis";

/** How conductor information is shown on the drawing. */
export type WiringSettings = {
  standard: WiringStandard;
  /** show the insulation colour code (or the cable core) next to the wire */
  showColor: boolean;
  showSection: boolean;
  /** small oblique tick through the wire at the annotation */
  tick: boolean;
  /** also draw wires in the standard color of their function (an explicit conductor color is always drawn) */
  colorize: boolean;
  /** where the wire number is written */
  numberAt?: "middle" | "ends" | "both";
  /** at each end, also write where the other end goes ("X1:8") */
  destination?: boolean;
  /** heavier lines for larger cross-sections */
  weightBySection: boolean;
};

export type CableCore = { name: string; color?: string };
/** A multi-core cable. Wires reference it by `tag` (Wire.cable) and pick a core (Wire.core). */
export type Cable = {
  id: string;
  tag: string;
  /** manufacturer type / part, e.g. "ÖLFLEX CLASSIC 110 4G1,5" */
  type?: string;
  cores: CableCore[];
  /** nominal cross-section of the cores */
  section?: string;
  shield?: boolean;
  length?: string;
  note?: string;
  /** per sheet: where the cable mark crosses the run (coordinate along the wires) and where its label was dragged (offset from the mark centre) */
  marks?: Record<string, { at?: number; label?: Pt }>;
};

/** Kind of terminal (drives the default colour in the plan and the BOM name). */
export type TerminalType = "feed" | "pe" | "neutral" | "fuse" | "disconnect" | "diode" | "sensor" | "multi";
/** One position on a terminal strip; `num` is the terminal number ("1", "03", "PE1"). */
export type StripRow = {
  num: string;
  type?: TerminalType;
  /** level of a multi-level terminal (1 = bottom) */
  level?: number;
  /** bridged (jumpered) to the next row */
  bridge?: boolean;
  partNumber?: string;
  note?: string;
  /** a terminal that exists on the rail but is not drawn */
  spare?: boolean;
};
export type TerminalStrip = {
  id: string;
  /** strip designation, e.g. "X1" */
  tag: string;
  /** between strip and terminal number in references: "X1:3" (":"), "X1-3" ("-"), "X1.3" (".") */
  sep: string;
  description?: string;
  location?: string;
  /** default terminal part number / manufacturer for the BOM */
  partNumber?: string;
  manufacturer?: string;
  rows: StripRow[];
};

export type Junction = { id: string; x: number; y: number; qetElemId?: string; group?: GroupRef };

export type FreeText = {
  id: string;
  x: number;
  y: number;
  text: string;
  role: TextRole;
  override?: Partial<TextStyle>;
  /** formatted text box (bullets, headings, **bold**, wrapping…); unset = plain text as typed */
  rich?: {
    /** wrap width in scene units; unset / 0 = no wrapping */
    width?: number;
    align?: "left" | "center" | "right" | "justify";
    /** line height multiplier (default from the text style) */
    lineHeight?: number;
    /** extra space between paragraphs, pt */
    paraGap?: number;
    /** inner padding, scene units (default 4) */
    padding?: number;
    border?: { color: string; width: number } | null;
    background?: string | null;
  };
  qet?: { idx?: number };
};

/** Free drawing shape (lines, rectangles, ellipses, polylines). Selectable and editable; written back on export. */
export type Shape = {
  id: string;
  kind: "line" | "rect" | "ellipse" | "polygon";
  pts: Pt[];
  /** polygons only: false = open polyline (default true) */
  closed?: boolean;
  color: string;
  width: number;
  dash: LineStyle["dash"];
  fill: string | null;
  /** picture placed on the page (rect shapes only): drawn fitted inside the rectangle */
  image?: TitleBlockLogo & { name?: string };
  qet?: { idx?: number };
};

export type TitleBlockTemplate = {
  name: string;
  /** parsed grid (QET titleblock template) */
  rows: number[];
  cols: { kind: "abs" | "t" | "r"; v: number }[];
  cells: {
    row: number;
    col: number;
    rowspan: number;
    colspan: number;
    type: "field" | "logo" | "empty";
    name?: string;
    label?: string;
    showLabel?: boolean;
    value?: string;
    align?: "left" | "center" | "right";
    size?: number;
  }[];
  /** logo resources by name (QET <logos>): only the ones a cell uses; base64 file data */
  logos?: Record<string, TitleBlockLogo>;
  xml?: string;
  /** copied from an organization title block layout (Administration) */
  layout?: { id: string; version: number };
};

export type TitleBlockLogo = { type: "png" | "jpg" | "svg"; data: string };

export type Page = {
  id: string;
  title: string;
  order: number;
  border: { show: boolean; cols: number; rows: number; colW: number; rowH: number; headerW: number; headerH: number; showCols: boolean; showRows: boolean };
  titleBlock: { show: boolean; template: string; fields: Record<string, string> };
  elements: ElemInst[];
  wires: Wire[];
  junctions: Junction[];
  texts: FreeText[];
  shapes: Shape[];
  meta: Record<string, string>;
  archived?: boolean;
  revMarker?: string;
  /** generated pages: a cover sheet or a table of contents (drawn from project data) */
  kind?: "drawing" | "cover" | "contents" | "terminals";
  cover?: CoverSheet;
  /** terminal diagram sheet: which strip, and which terminals (1-based positions in strip order; `to` unset = to the end) */
  terminalDiagram?: { tag: string; from?: number; to?: number; style?: "rail" | "box" };
  qet?: { idx?: number };
};

/** Cover sheet content (IEC 61082-1 / common practice: identification, data, manufacturer, revisions) */
export type CoverSheet = {
  /** big title; default: the project name */
  title?: string;
  subtitle?: string;
  /** product picture shown on the right */
  image?: TitleBlockLogo & { name?: string };
  /** company logo at the top left; unset = the organization logo (if configured), null = no logo */
  logo?: (TitleBlockLogo & { name?: string }) | null;
  /** project / product data (label → value; values may use %variables and project properties) */
  fields: { label: string; value: string }[];
  /** manufacturer name and address (one line per line) */
  manufacturer?: string;
  /** free notes (formatted: bullets, **bold**…) */
  notes?: string;
  /** confidentiality / copyright line at the bottom */
  notice?: string;
  /** show the revision history table (default true) */
  showRevisions?: boolean;
};

/** a row of the document revision history (shown on the cover sheet) */
export type RevisionEntry = { rev: string; date: string; description: string; drawn?: string; checked?: string; approved?: string };

export type NumberingRule = {
  id: string;
  match: string; // prefix or category ("*" for any)
  prefix: string;
  scope: "page" | "project" | "location";
  format: string; // tokens: {prefix} {n} {n:2} {page} {location}
  start: number;
};

export type Doc = {
  schema: 1;
  meta: { title: string; props: Record<string, string> };
  /** document revision history (cover sheet); newest last */
  revisions?: RevisionEntry[];
  /** snapshot of org template styles used as base (deterministic render) */
  baseStyles: Styles;
  baseStylesRef?: { templateId: string; version: number; name: string };
  /** project level partial overrides on top of base */
  styles: PartialStyles;
  /** closeGapsOnDelete: renumber references to close the gap when a component is deleted (default on) */
  numbering: { rules: NumberingRule[]; autoOnPlace: boolean; closeGapsOnDelete?: boolean };
  pages: Page[];
  defs: Record<string, ElementDef>;
  titleBlocks: Record<string, TitleBlockTemplate>;
  grid: { size: number; show: boolean };
  wiring?: WiringSettings;
  wireNumbering?: WireNumbering;
  cables?: Cable[];
  /** terminal strips: order, numbering and properties of terminals (Volt-only; labels go to .qet) */
  terminalStrips?: TerminalStrip[];
  qet?: {
    version: string;
    /** original .qet XML, used to preserve unknown nodes on export */
    source?: string;
    /** the source stays on the server; the editor receives only this marker and fetches it for export */
    hasSource?: boolean;
    filename?: string;
  };
};

/* ------------------------------------------------------------------ */
/* Blocks                                                               */
/* ------------------------------------------------------------------ */

export type BlockContent = {
  defs: Record<string, ElementDef>;
  elements: ElemInst[];
  wires: Wire[];
  junctions: Junction[];
  texts: FreeText[];
  ports: { name: string; x: number; y: number; el?: string; pin?: string }[];
  bbox: Rect;
};

/* ------------------------------------------------------------------ */
/* Compatibility report                                                 */
/* ------------------------------------------------------------------ */

export type CompatLevel = "supported" | "degraded" | "preserved" | "unsupported";
export type CompatItem = { level: CompatLevel; area: string; message: string; count?: number; page?: string };
export type CompatReport = {
  source: string;
  qetVersion: string;
  pageCount: number;
  elementCount: number;
  wireCount: number;
  definitionCount: number;
  items: CompatItem[];
  createdAt: string;
};

/* ------------------------------------------------------------------ */
/* Workflow (shared constants)                                          */
/* ------------------------------------------------------------------ */

export const VERSION_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REJECTED",
  "SIGNED",
  "RELEASED",
  "SUPERSEDED",
  "WITHDRAWN",
  "OBSOLETE",
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export const EDITABLE_STATUSES: VersionStatus[] = ["DRAFT", "CHANGES_REQUESTED"];
