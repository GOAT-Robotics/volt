import type { DeepPartial, PartialStyles, Styles, TextRole, TextStyle } from "./model";
import { TEXT_ROLES } from "./model";

const T = (o: Partial<TextStyle>): TextStyle => ({
  font: "Inter, Helvetica, Arial, sans-serif",
  size: 9,
  weight: 400,
  italic: false,
  color: "#111827",
  background: null,
  align: "left",
  rotation: 0,
  dx: 0,
  dy: 0,
  lineHeight: 1.2,
  visible: true,
  ...o,
});

export const ROLE_LABELS: Record<TextRole, string> = {
  componentName: "Component name",
  componentRating: "Component rating",
  componentPartNumber: "Component part number",
  componentManufacturer: "Component manufacturer",
  componentRef: "Component reference",
  connectorName: "Connector name",
  pinNumber: "Pin number",
  pinName: "Pin name",
  wireLabel: "Wire label",
  wireInfo: "Wire color / cross-section",
  cableLabel: "Cable label",
  terminalLabel: "Terminal label",
  annotation: "General annotation",
  pageTitle: "Page title",
  titleBlockField: "Title block field",
  revisionTable: "Revision table",
};

export function defaultStyles(): Styles {
  return {
    text: {
      componentName: T({ size: 8, color: "#374151", dx: 0, dy: 0 }),
      componentRating: T({ size: 8, color: "#374151" }),
      componentPartNumber: T({ size: 7, color: "#6b7280" }),
      componentManufacturer: T({ size: 7, color: "#6b7280" }),
      componentRef: T({ size: 10, weight: 600, color: "#111827" }),
      connectorName: T({ size: 9, weight: 600 }),
      pinNumber: T({ size: 6, color: "#6b7280" }),
      pinName: T({ size: 6, color: "#374151", visible: false }),
      wireLabel: T({ size: 7, color: "#1d4ed8", background: "#ffffff" }),
      wireInfo: T({ size: 6, color: "#374151" }),
      cableLabel: T({ size: 7, color: "#7c3aed", italic: true }),
      terminalLabel: T({ size: 8, color: "#111827" }),
      annotation: T({ size: 9, color: "#111827" }),
      pageTitle: T({ size: 14, weight: 700 }),
      titleBlockField: T({ size: 8 }),
      revisionTable: T({ size: 7 }),
    },
    graphics: {
      wire: { color: "#111827", width: 1, dash: "solid", junctionRadius: 2.5, junctionColor: "#111827", highlight: "#2563eb" },
      bus: { color: "#111827", width: 3, dash: "solid" },
      pin: { color: "#dc2626", size: 2, showPoint: true },
      outline: { color: null, widthScale: 1 },
      frame: { show: false, color: "#111827", width: 0.8, dash: "dashed", padding: 4 },
      componentInfo: { description: true, rating: true, manufacturer_reference: false, manufacturer: false },
      componentInfoLayout: { at: "auto" },
      border: { color: "#6b7280", width: 1, dash: "solid", headerColor: "#f3f4f6", font: "Inter, Helvetica, Arial, sans-serif", size: 8 },
      titleBlock: { color: "#374151", width: 1, dash: "solid", font: "Inter, Helvetica, Arial, sans-serif" },
      selection: "#2563eb",
      review: { added: "#16a34a", removed: "#dc2626", changed: "#d97706", comment: "#9333ea" },
    },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: DeepPartial<T> | undefined | null): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === undefined) continue;
    const b = out[k];
    out[k] = isObj(b) && isObj(v) ? deepMerge(b, v as DeepPartial<typeof b>) : v;
  }
  return out as T;
}

/** org base ⊕ project partial */
export function projectStyles(base: Styles, partial: PartialStyles | undefined): Styles {
  // defaults first: style snapshots saved before a style key existed still get a value for it
  return deepMerge(deepMerge(defaultStyles(), base as DeepPartial<Styles>), partial as DeepPartial<Styles>);
}

/** effective text style: project ⊕ element-def default ⊕ object override */
export function effectiveText(styles: Styles, role: TextRole, ...overrides: (Partial<TextStyle> | undefined)[]): TextStyle {
  let s = styles.text[role] ?? styles.text.annotation;
  for (const o of overrides) if (o) s = { ...s, ...stripUndef(o) };
  return s;
}

function stripUndef<T extends object>(o: T): Partial<T> {
  const r: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

export function isRole(s: string): s is TextRole {
  return (TEXT_ROLES as readonly string[]).includes(s);
}

export function cssFont(s: TextStyle, scale = 1): string {
  return `${s.italic ? "italic " : ""}${s.weight} ${s.size * scale}px ${s.font}`;
}

/** QET named colours -> css */
export const QET_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#e11d48",
  green: "#16a34a",
  blue: "#2563eb",
  gray: "#6b7280",
  brun: "#92400e",
  yellow: "#eab308",
  cyan: "#06b6d4",
  magenta: "#c026d3",
  lightgray: "#d1d5db",
  orange: "#f97316",
  purple: "#7c3aed",
  none: "transparent",
};
export const CSS_NAMED: Record<string, string> = {aliceblue:"#f0f8ff",antiquewhite:"#faebd7",aqua:"#00ffff",aquamarine:"#7fffd4",azure:"#f0ffff",beige:"#f5f5dc",bisque:"#ffe4c4",black:"#000000",blanchedalmond:"#ffebcd",blue:"#0000ff",blueviolet:"#8a2be2",brown:"#a52a2a",burlywood:"#deb887",cadetblue:"#5f9ea0",chartreuse:"#7fff00",chocolate:"#d2691e",coral:"#ff7f50",cornflowerblue:"#6495ed",cornsilk:"#fff8dc",crimson:"#dc143c",cyan:"#00ffff",darkblue:"#00008b",darkcyan:"#008b8b",darkgoldenrod:"#b8860b",darkgray:"#a9a9a9",darkgreen:"#006400",darkgrey:"#a9a9a9",darkkhaki:"#bdb76b",darkmagenta:"#8b008b",darkolivegreen:"#556b2f",darkorange:"#ff8c00",darkorchid:"#9932cc",darkred:"#8b0000",darksalmon:"#e9967a",darkseagreen:"#8fbc8f",darkslateblue:"#483d8b",darkslategray:"#2f4f4f",darkslategrey:"#2f4f4f",darkturquoise:"#00ced1",darkviolet:"#9400d3",deeppink:"#ff1493",deepskyblue:"#00bfff",dimgray:"#696969",dimgrey:"#696969",dodgerblue:"#1e90ff",firebrick:"#b22222",floralwhite:"#fffaf0",forestgreen:"#228b22",fuchsia:"#ff00ff",gainsboro:"#dcdcdc",ghostwhite:"#f8f8ff",gold:"#ffd700",goldenrod:"#daa520",gray:"#808080",grey:"#808080",green:"#008000",greenyellow:"#adff2f",honeydew:"#f0fff0",hotpink:"#ff69b4",indianred:"#cd5c5c",indigo:"#4b0082",ivory:"#fffff0",khaki:"#f0e68c",lavender:"#e6e6fa",lavenderblush:"#fff0f5",lawngreen:"#7cfc00",lemonchiffon:"#fffacd",lightblue:"#add8e6",lightcoral:"#f08080",lightcyan:"#e0ffff",lightgoldenrodyellow:"#fafad2",lightgray:"#d3d3d3",lightgreen:"#90ee90",lightgrey:"#d3d3d3",lightpink:"#ffb6c1",lightsalmon:"#ffa07a",lightseagreen:"#20b2aa",lightskyblue:"#87cefa",lightslategray:"#778899",lightslategrey:"#778899",lightsteelblue:"#b0c4de",lightyellow:"#ffffe0",lime:"#00ff00",limegreen:"#32cd32",linen:"#faf0e6",magenta:"#ff00ff",maroon:"#800000",mediumaquamarine:"#66cdaa",mediumblue:"#0000cd",mediumorchid:"#ba55d3",mediumpurple:"#9370db",mediumseagreen:"#3cb371",mediumslateblue:"#7b68ee",mediumspringgreen:"#00fa9a",mediumturquoise:"#48d1cc",mediumvioletred:"#c71585",midnightblue:"#191970",mintcream:"#f5fffa",mistyrose:"#ffe4e1",moccasin:"#ffe4b5",navajowhite:"#ffdead",navy:"#000080",oldlace:"#fdf5e6",olive:"#808000",olivedrab:"#6b8e23",orange:"#ffa500",orangered:"#ff4500",orchid:"#da70d6",palegoldenrod:"#eee8aa",palegreen:"#98fb98",paleturquoise:"#afeeee",palevioletred:"#db7093",papayawhip:"#ffefd5",peachpuff:"#ffdab9",peru:"#cd853f",pink:"#ffc0cb",plum:"#dda0dd",powderblue:"#b0e0e6",purple:"#800080",red:"#ff0000",rosybrown:"#bc8f8f",royalblue:"#4169e1",saddlebrown:"#8b4513",salmon:"#fa8072",sandybrown:"#f4a460",seagreen:"#2e8b57",seashell:"#fff5ee",sienna:"#a0522d",silver:"#c0c0c0",skyblue:"#87ceeb",slateblue:"#6a5acd",slategray:"#708090",slategrey:"#708090",snow:"#fffafa",springgreen:"#00ff7f",steelblue:"#4682b4",tan:"#d2b48c",teal:"#008080",thistle:"#d8bfd8",tomato:"#ff6347",turquoise:"#40e0d0",violet:"#ee82ee",wheat:"#f5deb3",white:"#ffffff",whitesmoke:"#f5f5f5",yellow:"#ffff00",yellowgreen:"#9acd32",rebeccapurple:"#663399"};

/** QET colour names: legacy names (black, red…), "#rrggbb", or QET ≥0.8 HTML palette names such as
 *  "HTMLGrayBlack" / "HTMLWhiteWhiteSmoke" (group prefix + CSS colour name). Always returns hex. */
export function qetColor(c: string | undefined, fallback = "#000000"): string {
  if (!c) return fallback;
  if (QET_COLORS[c]) return QET_COLORS[c];
  if (c.startsWith("#")) return /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback;
  const m = /^HTML(Pink|Red|Orange|Yellow|Brown|Purple|White|Gray|Grey|Blue|Cyan|Green)(\w+)$/.exec(c);
  if (m) return CSS_NAMED[m[2].toLowerCase()] ?? fallback;
  return CSS_NAMED[c.toLowerCase()] ?? fallback;
}
export const QET_WEIGHTS: Record<string, number> = { none: 0, thin: 0.5, normal: 1, hight: 2, eleve: 5 };
