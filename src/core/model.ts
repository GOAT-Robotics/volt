/**
 * Volt document model. Isomorphic (browser + server), JSON-serialisable.
 * Coordinates are QElectroTech scene units (1 unit = 1 px at 100% zoom; grid 10).
 */

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
};

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
  "componentRef",
  "connectorName",
  "pinNumber",
  "pinName",
  "wireLabel",
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

export type LineStyle = { color: string; width: number; dash: "solid" | "dashed" | "dotted" | "dashdot" };

export type GraphicStyles = {
  wire: LineStyle & { junctionRadius: number; junctionColor: string; highlight: string };
  bus: LineStyle;
  pin: { color: string; size: number; showPoint: boolean };
  outline: { color: string | null; widthScale: number };
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
};

export type ElemInst = {
  id: string; // QET uuid without braces
  defId: string;
  x: number;
  y: number;
  rot: 0 | 1 | 2 | 3; // ×90° clockwise
  mirror: boolean;
  /** elementInformations (label, comment, function, manufacturer, ...) */
  info: Record<string, string>;
  texts: PlacedText[];
  refLocked?: boolean;
  locked?: boolean;
  hidden?: boolean;
  z?: number;
  showPinNumbers?: boolean;
  showPinNames?: boolean;
  outlineOverride?: Partial<LineStyle>;
  group?: GroupRef;
  /** QElectroTech cross-reference links (folio report pairs, master ↔ slaves): ids of linked elements */
  links?: string[];
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
  cable?: string;
  bus?: boolean;
  override?: Partial<LineStyle>;
  group?: GroupRef;
  qet?: { idx?: number; attrs?: Record<string, string> };
};

export type Junction = { id: string; x: number; y: number; qetElemId?: string; group?: GroupRef };

export type FreeText = {
  id: string;
  x: number;
  y: number;
  text: string;
  role: TextRole;
  override?: Partial<TextStyle>;
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
  xml?: string;
};

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
  qet?: { idx?: number };
};

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
  /** snapshot of org template styles used as base (deterministic render) */
  baseStyles: Styles;
  baseStylesRef?: { templateId: string; version: number; name: string };
  /** project level partial overrides on top of base */
  styles: PartialStyles;
  numbering: { rules: NumberingRule[]; autoOnPlace: boolean };
  pages: Page[];
  defs: Record<string, ElementDef>;
  titleBlocks: Record<string, TitleBlockTemplate>;
  grid: { size: number; show: boolean };
  qet?: {
    version: string;
    /** original .qet XML, used to preserve unknown nodes on export */
    source?: string;
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
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export const EDITABLE_STATUSES: VersionStatus[] = ["DRAFT", "CHANGES_REQUESTED"];
