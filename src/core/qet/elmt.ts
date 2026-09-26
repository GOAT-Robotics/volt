/**
 * QElectroTech element definition (.elmt) <-> Volt ElementDef.
 *
 * Coordinate conventions (all verified against the QET C++ sources, see comments inline):
 *  - All primitive coordinates are local to the element *hotspot* (Element::boundingRect() is
 *    QRectF(-hotspot, size), so the item origin is the hotspot).
 *  - <terminal x y>: the conductor docking point (TerminalData::m_pos). The terminal stub is drawn
 *    from there 4 units (Terminal::terminalSize) towards the element body (Terminal::init()).
 *  - <arc start angle>: degrees, Qt convention — 0° at 3 o'clock, positive = counter-clockwise on
 *    screen (QPainter::drawArc(rect, start*16, angle*16), ElementPictureFactory::parseArc).
 *  - <text x y>: x,y is the *baseline-left* of the first line (ElementPictureFactory::parseText
 *    translates by -ascent), rotation (degrees, clockwise) about that point.
 *  - <dynamic_text x y>: x,y is the *top-left* of the QGraphicsTextItem box, which carries Qt's
 *    default 4 px QTextDocument margin (glyph box starts at x+4,y+4). Rotation (clockwise degrees)
 *    is about that top-left point unless rotation_point_center="true".
 *  - legacy <input x y> (pre 0.7 text field): x,y is the *middle-left* of the text box.
 *    Element::parseInput() converts it to a dynamic text at (x,y) + rotate(0, -boxHeight/2); we do
 *    the same so every dyntext prim uses the top-left convention.
 *  - legacy <circle x y diameter>: bounding-square top-left + diameter → ellipse.
 */
import type { ElementDef, LineEnd, Orient, PinDef, Prim, PrimStyle, Pt } from "../model";
import { stableStringify } from "../stable-json";
import {
  adopt,
  attr,
  bool,
  child,
  children,
  createEl,
  fmt,
  formatSubtree,
  isElement,
  normUuid,
  num,
  optAttr,
  parseQtFont,
  parseXml,
  qtFontString,
  replaceIndented,
  serializeXml,
  setAttrs,
  setText,
  textOf,
  type XDocument,
  type XElement,
} from "./xml";

/** Version attribute written on newly generated definitions / projects (QET 0.100 release). */
export const QET_VERSION = "0.100.0";
/** Terminal::terminalSize */
export const TERMINAL_SIZE = 4;

export type ParseElmtOptions = { id?: string; category?: string };

const DEFAULT_STYLE: PrimStyle = { lineStyle: "normal", lineWeight: "normal", filling: "none", color: "black" };

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

export function orientFromQet(s: string | null | undefined): Orient {
  // Qet::orientationFromString(): first char e/s/w, anything else = North
  const c = (s ?? "").charAt(0);
  return c === "e" ? "e" : c === "s" ? "s" : c === "w" ? "w" : "n";
}
export const ORIENT_INDEX: Record<Orient, number> = { n: 0, e: 1, s: 2, w: 3 }; // Qet::Orientation enum
export const ORIENT_FROM_INDEX: Orient[] = ["n", "e", "s", "w"];

/**
 * Offset from a terminal's conductor dock point (pin position) to the element-side end of its
 * stub ("dock_elmt_" in Terminal::init()). Project files store *this* inner point in the
 * instance <terminals> list (Terminal::toXml()).
 */
export function dockElmtOffset(o: Orient): Pt {
  switch (o) {
    case "n":
      return { x: 0, y: TERMINAL_SIZE };
    case "e":
      return { x: -TERMINAL_SIZE, y: 0 };
    case "s":
      return { x: 0, y: -TERMINAL_SIZE };
    default:
      return { x: TERMINAL_SIZE, y: 0 };
  }
}

export function parseStyle(s: string | null | undefined): PrimStyle {
  const st: PrimStyle = { ...DEFAULT_STYLE };
  for (const part of (s ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!v) continue;
    if (k === "line-style" && (v === "normal" || v === "dashed" || v === "dotted" || v === "dashdotted")) st.lineStyle = v;
    else if (k === "line-weight" && (v === "none" || v === "thin" || v === "normal" || v === "hight" || v === "eleve")) st.lineWeight = v;
    else if (k === "filling") st.filling = v;
    else if (k === "color") st.color = v;
  }
  return st;
}

export function styleToString(s: PrimStyle): string {
  return `line-style:${s.lineStyle};line-weight:${s.lineWeight};filling:${s.filling};color:${s.color}`;
}

function lineEnd(s: string | null): LineEnd {
  // Qet::endTypeFromString()
  return s === "simple" || s === "triangle" || s === "circle" || s === "diamond" ? s : "none";
}

const HALIGN: Record<string, "left" | "center" | "right"> = { AlignLeft: "left", AlignHCenter: "center", AlignRight: "right" };
const VALIGN: Record<string, "top" | "center" | "bottom"> = { AlignTop: "top", AlignVCenter: "center", AlignBottom: "bottom" };
const HALIGN_REV = { left: "AlignLeft", center: "AlignHCenter", right: "AlignRight" } as const;
const VALIGN_REV = { top: "AlignTop", center: "AlignVCenter", bottom: "AlignBottom" } as const;

export const halignFromQet = (s: string | undefined) => (s && HALIGN[s]) || "left";
export const valignFromQet = (s: string | undefined) => (s && VALIGN[s]) || "top";
export const halignToQet = (a: "left" | "center" | "right") => HALIGN_REV[a];
export const valignToQet = (a: "top" | "center" | "bottom") => VALIGN_REV[a];

/** Approximate QGraphicsTextItem box height for a point size (line height at 96 dpi + 2×4 px margin). */
export const textBoxHeight = (pointSize: number) => (pointSize * 5) / 3 + 8;

/** Top-left dyntext position of a legacy <input> (Element::parseInput()). */
export function legacyInputToTopLeft(x: number, y: number, size: number, rotationDeg: number): Pt {
  const h = textBoxHeight(size);
  const r = (rotationDeg * Math.PI) / 180;
  // QTransform.rotate(r).map(0, -h/2)
  return { x: x + (h / 2) * Math.sin(r), y: y - (h / 2) * Math.cos(r) };
}

const numericLooking = (s: string) => /^\d+$/.test(s.trim());

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function parseNames(defEl: XElement): Record<string, string> {
  const names: Record<string, string> = {};
  for (const n of children(child(defEl, "names"), "name")) {
    const lang = attr(n, "lang", "en");
    names[lang] = textOf(n);
  }
  return names;
}

function parseContext(container: XElement | null, tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of children(container, tag)) {
    const name = attr(p, "name");
    if (name) out[name] = textOf(p);
  }
  return out;
}

function parseDynText(e: XElement): Extract<Prim, { t: "dyntext" }> {
  const tf = attr(e, "text_from", "UserText");
  const from = tf === "ElementInfo" || tf === "CompositeText" ? tf : "UserText";
  const font = parseQtFont(optAttr(e, "font"));
  const size = font.size ?? num(e, "font_size", 9);
  const infoName = child(e, "info_name");
  const color = child(e, "color");
  const p: Extract<Prim, { t: "dyntext" }> = {
    t: "dyntext",
    x: num(e, "x"),
    y: num(e, "y"),
    from,
    text: from === "CompositeText" ? textOf(child(e, "composite_text")) : textOf(child(e, "text")),
    size,
    rotation: num(e, "rotation"),
    halign: halignFromQet(optAttr(e, "Halignment")),
    valign: valignFromQet(optAttr(e, "Valignment")),
    frame: bool(e, "frame"),
    width: num(e, "text_width", -1),
  };
  if (infoName) p.info = textOf(infoName);
  const u = normUuid(optAttr(e, "uuid"));
  if (u) p.uuid = u;
  if (color && textOf(color)) p.color = textOf(color);
  return p;
}

/** Parse one description child into a primitive (null for terminals / unknown nodes). */
function parsePrim(e: XElement): Prim | null {
  const style = parseStyle(optAttr(e, "style"));
  switch (e.tagName) {
    case "line":
      return {
        t: "line",
        x1: num(e, "x1"),
        y1: num(e, "y1"),
        x2: num(e, "x2"),
        y2: num(e, "y2"),
        end1: lineEnd(e.getAttribute("end1")),
        end2: lineEnd(e.getAttribute("end2")),
        // ElementPictureFactory::parseLine(): default 1.5 when missing
        len1: num(e, "length1", 1.5),
        len2: num(e, "length2", 1.5),
        style,
      };
    case "rect":
      return { t: "rect", x: num(e, "x"), y: num(e, "y"), w: num(e, "width"), h: num(e, "height"), rx: num(e, "rx"), ry: num(e, "ry"), style };
    case "ellipse":
      return { t: "ellipse", x: num(e, "x"), y: num(e, "y"), w: num(e, "width"), h: num(e, "height"), style };
    case "circle": {
      // legacy: bounding square top-left + diameter (ElementPictureFactory::parseCircle)
      const d = num(e, "diameter");
      return { t: "ellipse", x: num(e, "x"), y: num(e, "y"), w: d, h: d, style };
    }
    case "arc":
      return { t: "arc", x: num(e, "x"), y: num(e, "y"), w: num(e, "width"), h: num(e, "height"), start: num(e, "start"), angle: num(e, "angle"), style };
    case "polygon": {
      // x1,y1,x2,y2,... until a pair is missing (ElementPictureFactory::parsePolygon)
      const pts: Pt[] = [];
      for (let i = 1; e.hasAttribute(`x${i}`) && e.hasAttribute(`y${i}`); i++) pts.push({ x: num(e, `x${i}`), y: num(e, `y${i}`) });
      return { t: "polygon", pts, closed: e.getAttribute("closed") !== "false", style };
    }
    case "text": {
      const font = parseQtFont(optAttr(e, "font"));
      const p: Extract<Prim, { t: "text" }> = {
        t: "text",
        x: num(e, "x"),
        y: num(e, "y"),
        text: attr(e, "text"),
        size: e.hasAttribute("size") ? num(e, "size", 9) : (font.size ?? 9),
        rotation: num(e, "rotation"),
        color: attr(e, "color", "#000000"),
      };
      if (font.family) p.font = font.family;
      return p;
    }
    case "dynamic_text":
      return parseDynText(e);
    case "input": {
      // legacy text field -> dynamic text (Element::parseInput())
      const size = num(e, "size", 9);
      const rotation = num(e, "rotation");
      const tl = legacyInputToTopLeft(num(e, "x"), num(e, "y"), size, rotation);
      const tagg = attr(e, "tagg", "none");
      const p: Extract<Prim, { t: "dyntext" }> = {
        t: "dyntext",
        x: tl.x,
        y: tl.y,
        from: tagg !== "none" ? "ElementInfo" : "UserText",
        text: attr(e, "text", "_"),
        size,
        rotation,
        halign: "left",
        valign: "top",
        frame: false,
        width: -1,
      };
      if (tagg !== "none") p.info = tagg;
      return p;
    }
    default:
      return null;
  }
}

function parsePin(e: XElement, index: number): PinDef {
  const uuid = normUuid(optAttr(e, "uuid"));
  const name = attr(e, "name");
  const numberAttr = optAttr(e, "number");
  return {
    id: uuid || `t${index}`,
    x: num(e, "x"),
    y: num(e, "y"),
    orient: orientFromQet(e.getAttribute("orientation")),
    name,
    number: numberAttr ?? (numericLooking(name) ? name : ""),
    type: attr(e, "type", "Generic") || "Generic",
  };
}

/** Tags inside <description> that we model. */
const PRIM_TAGS = new Set(["line", "rect", "ellipse", "circle", "arc", "polygon", "text", "dynamic_text", "input"]);

/**
 * The first <input> of a legacy definition gets tagg="label" when none has it
 * (Element::buildFromXml() "minor workaround").
 */
function legacyLabelFix(desc: XElement): Set<XElement> {
  const inputs = children(desc, "input");
  const forced = new Set<XElement>();
  if (inputs.length && !inputs.some((i) => attr(i, "tagg", "none") === "label")) forced.add(inputs[0]);
  return forced;
}

export function parseElmtNode(defEl: XElement, opts: ParseElmtOptions = {}, xml?: string): ElementDef {
  if (defEl.tagName !== "definition") throw new Error(`not an element definition: <${defEl.tagName}>`);
  const names = parseNames(defEl);
  const uuidEl = child(defEl, "uuid");
  const uuid = normUuid(uuidEl ? optAttr(uuidEl, "uuid") : undefined);
  const kind = parseContext(child(defEl, "kindInformations"), "kindInformation");
  const info = parseContext(child(defEl, "elementInformations"), "elementInformation");
  const meta: Record<string, string> = {};
  const informations = child(defEl, "informations");
  if (informations) meta.informations = textOf(informations);
  const version = optAttr(defEl, "version");
  if (version) meta.qetVersion = version;

  const prims: Prim[] = [];
  const pins: PinDef[] = [];
  const desc = child(defEl, "description");
  if (desc) {
    const forcedLabel = legacyLabelFix(desc);
    for (const e of children(desc)) {
      if (e.tagName === "terminal") {
        pins.push(parsePin(e, pins.length));
        continue;
      }
      if (!PRIM_TAGS.has(e.tagName)) continue;
      const p = parsePrim(e);
      if (!p) continue;
      if (forcedLabel.has(e) && p.t === "dyntext") {
        p.from = "ElementInfo";
        p.info = "label";
      }
      prims.push(p);
    }
  }

  const fallbackName = (opts.id ?? "").split("/").pop()?.replace(/\.elmt$/i, "") ?? "";
  const name = names.en ?? Object.values(names)[0] ?? fallbackName ?? "element";
  // Prefix: QET keeps element prefixes in the category's qet_directory (<prefix>), not in the
  // definition (AssignVariables); accept an explicit <prefix> child or kindInformation if present.
  const prefix = textOf(child(defEl, "prefix")) || kind.prefix || "";

  return {
    id: opts.id ?? (uuid ? `uuid:${uuid}` : name),
    uuid,
    name,
    names,
    width: num(defEl, "width"),
    height: num(defEl, "height"),
    hotspotX: num(defEl, "hotspot_x"),
    hotspotY: num(defEl, "hotspot_y"),
    linkType: attr(defEl, "link_type", "simple") || "simple",
    prefix,
    category: opts.category ?? "",
    prims,
    pins,
    info,
    kind,
    meta,
    xml: xml ?? serializeXml(defEl),
  };
}

/** Parse a .elmt document (root <definition>). */
export function parseElmt(xml: string, opts: ParseElmtOptions = {}): ElementDef {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root) throw new Error("empty .elmt document");
  return parseElmtNode(root, opts, xml);
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

/** The parts of a definition that serializeElmt writes; used for change detection. */
export function defSignature(d: ElementDef): string {
  return stableStringify({
    uuid: d.uuid,
    names: d.names,
    width: d.width,
    height: d.height,
    hotspotX: d.hotspotX,
    hotspotY: d.hotspotY,
    linkType: d.linkType,
    prims: d.prims,
    pins: d.pins,
    info: d.info,
    kind: d.kind,
    informations: d.meta.informations ?? "",
  });
}

/** True when `def` differs from what its original `xml` describes (or has no xml). */
export function defModified(def: ElementDef): boolean {
  if (!def.xml) return true;
  try {
    const orig = parseElmt(def.xml, { id: def.id, category: def.category });
    return defSignature(orig) !== defSignature(def);
  } catch {
    return true;
  }
}

const roundUp10 = (v: number) => Math.max(10, Math.ceil(Math.round(v) / 10) * 10);

function writePrim(doc: XDocument, p: Prim, base: XElement | null): XElement {
  const tag =
    p.t === "dyntext" ? "dynamic_text" : p.t === "ellipse" ? "ellipse" : p.t === "rect" ? "rect" : p.t === "line" ? "line" : p.t === "arc" ? "arc" : p.t === "polygon" ? "polygon" : "text";
  const e = base && base.tagName === tag ? base : doc.createElement(tag);
  switch (p.t) {
    case "line":
      setAttrs(e, { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, end1: p.end1, end2: p.end2, length1: p.len1, length2: p.len2, style: styleToString(p.style) });
      if (!e.hasAttribute("antialias")) e.setAttribute("antialias", "false");
      break;
    case "rect":
      setAttrs(e, { x: p.x, y: p.y, width: p.w, height: p.h, rx: p.rx, ry: p.ry, style: styleToString(p.style) });
      if (!e.hasAttribute("antialias")) e.setAttribute("antialias", "false");
      break;
    case "ellipse":
      setAttrs(e, { x: p.x, y: p.y, width: p.w, height: p.h, style: styleToString(p.style) });
      if (!e.hasAttribute("antialias")) e.setAttribute("antialias", "false");
      break;
    case "arc":
      setAttrs(e, { x: p.x, y: p.y, width: p.w, height: p.h, start: p.start, angle: p.angle, style: styleToString(p.style) });
      if (!e.hasAttribute("antialias")) e.setAttribute("antialias", "false");
      break;
    case "polygon": {
      // drop stale point attributes of a reused node
      for (let i = 1; e.hasAttribute(`x${i}`) || e.hasAttribute(`y${i}`); i++) {
        e.removeAttribute(`x${i}`);
        e.removeAttribute(`y${i}`);
      }
      p.pts.forEach((pt, i) => setAttrs(e, { [`x${i + 1}`]: pt.x, [`y${i + 1}`]: pt.y }));
      setAttrs(e, { closed: p.closed ? "true" : "false", style: styleToString(p.style) });
      if (!e.hasAttribute("antialias")) e.setAttribute("antialias", "false");
      break;
    }
    case "text": {
      setAttrs(e, { x: p.x, y: p.y, text: p.text, rotation: p.rotation, color: p.color });
      if (p.font || e.hasAttribute("font")) {
        const f = parseQtFont(optAttr(e, "font"));
        setAttrs(e, { font: qtFontString(p.font ?? f.family ?? "Sans Serif", p.size, f.bold, f.italic), size: undefined });
      } else setAttrs(e, { size: p.size });
      break;
    }
    case "dyntext": {
      const f = parseQtFont(optAttr(e, "font"));
      setAttrs(e, {
        x: p.x,
        y: p.y,
        rotation: p.rotation,
        text_from: p.from,
        Halignment: halignToQet(p.halign),
        Valignment: valignToQet(p.valign),
        frame: p.frame ? "true" : "false",
        text_width: p.width,
        font: qtFontString(f.family ?? "Sans Serif", p.size, f.bold, f.italic),
        font_size: undefined,
        uuid: p.uuid ? `{${p.uuid}}` : undefined,
      });
      for (const c of children(e)) e.removeChild(c);
      while (e.firstChild) e.removeChild(e.firstChild);
      if (p.from === "CompositeText") {
        e.appendChild(createEl(doc, "text"));
        e.appendChild(createEl(doc, "composite_text", {}, [p.text]));
      } else e.appendChild(createEl(doc, "text", {}, p.text ? [p.text] : []));
      if (p.info) e.appendChild(createEl(doc, "info_name", {}, [p.info]));
      if (p.color) e.appendChild(createEl(doc, "color", {}, [p.color]));
      break;
    }
  }
  return e;
}

function writePin(doc: XDocument, p: PinDef, base: XElement | null): XElement {
  const e = base ?? doc.createElement("terminal");
  // TerminalData::toXml()
  setAttrs(e, {
    x: p.x,
    y: p.y,
    orientation: p.orient,
    name: p.name || p.number,
    type: p.type || "Generic",
    uuid: /^t\d+$/.test(p.id) ? e.getAttribute("uuid") ?? undefined : `{${p.id}}`,
  });
  if (p.number && p.number !== (p.name || p.number)) e.setAttribute("number", p.number);
  else if (e.hasAttribute("number") && numericLooking(p.name)) e.removeAttribute("number");
  return e;
}

function writeContext(doc: XDocument, tag: string, itemTag: string, ctx: Record<string, string>, withShow: boolean): XElement {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(ctx)) el.appendChild(createEl(doc, itemTag, withShow ? { name: k, show: 1 } : { name: k }, v ? [v] : []));
  return el;
}

function writeNames(doc: XDocument, names: Record<string, string>, fallback: string): XElement {
  const el = doc.createElement("names");
  const entries = Object.entries(names);
  if (!entries.length) entries.push(["en", fallback]);
  for (const [lang, v] of entries) el.appendChild(createEl(doc, "name", { lang }, [v]));
  return el;
}

/** Put `node` in place of the first `tag` child of `parent` (or insert it before `beforeTag`). */
function putChild(doc: XDocument, parent: XElement, tag: string, node: XElement | null, beforeTags: string[]): void {
  const old = child(parent, tag);
  if (old && node) replaceIndented(doc, old, node);
  else if (old && !node) parent.removeChild(old);
  else if (node) {
    let ref: XElement | null = null;
    for (const t of beforeTags) if ((ref = child(parent, t))) break;
    if (ref) parent.insertBefore(node, ref);
    else parent.appendChild(node);
  }
}

function buildDescription(doc: XDocument, def: ElementDef, orig: XElement | null): XElement {
  const desc = doc.createElement("description");
  const origKnown = orig ? children(orig).filter((c) => PRIM_TAGS.has(c.tagName)) : [];
  const origTerms = orig ? children(orig, "terminal") : [];
  const unknown = orig ? children(orig).filter((c) => !PRIM_TAGS.has(c.tagName) && c.tagName !== "terminal") : [];
  def.prims.forEach((p, i) => {
    const base = origKnown[i] ? (origKnown[i].cloneNode(true) as XElement) : null;
    desc.appendChild(writePrim(doc, p, base));
  });
  for (const u of unknown) desc.appendChild(u.cloneNode(true));
  def.pins.forEach((p, i) => {
    let base: XElement | null = null;
    const byUuid = origTerms.find((t) => normUuid(optAttr(t, "uuid")) === p.id);
    if (byUuid) base = byUuid;
    else if (p.id === `t${i}` && origTerms[i] && !optAttr(origTerms[i], "uuid")) base = origTerms[i];
    desc.appendChild(writePin(doc, p, base ? (base.cloneNode(true) as XElement) : null));
  });
  return desc;
}

/**
 * Serialise an ElementDef to a QET .elmt <definition>. When `def.xml` is present the original
 * document is patched: only the parts that differ from it are rewritten, and unknown attributes /
 * nodes are kept. Otherwise a fresh definition is generated.
 */
export function serializeElmt(def: ElementDef): string {
  let doc: XDocument;
  let root: XElement;
  let orig: ElementDef | null = null;
  if (def.xml) {
    doc = parseXml(def.xml);
    root = doc.documentElement as XElement;
    try {
      orig = parseElmtNode(root, { id: def.id, category: def.category }, def.xml);
    } catch {
      orig = null;
    }
    if (!orig) {
      doc = parseXml("<definition/>");
      root = doc.documentElement as XElement;
    }
  } else {
    doc = parseXml("<definition/>");
    root = doc.documentElement as XElement;
  }
  const fresh = !orig;
  if (orig && defSignature(orig) === defSignature(def)) return def.xml as string;

  // Element::buildFromXml() requires integer width/height/hotspot; sizes are rounded up to tens.
  setAttrs(root, {
    type: "element",
    version: fresh ? QET_VERSION : (root.getAttribute("version") ?? QET_VERSION),
    link_type: def.linkType || "simple",
    width: fresh || orig?.width !== def.width ? roundUp10(def.width) : root.getAttribute("width") ?? roundUp10(def.width),
    height: fresh || orig?.height !== def.height ? roundUp10(def.height) : root.getAttribute("height") ?? roundUp10(def.height),
    hotspot_x: Math.round(def.hotspotX),
    hotspot_y: Math.round(def.hotspotY),
  });

  if (def.uuid && (fresh || orig?.uuid !== def.uuid)) {
    putChild(doc, root, "uuid", createEl(doc, "uuid", { uuid: `{${def.uuid}}` }), ["names", "kindInformations", "elementInformations", "informations", "description"]);
  }
  if (fresh || stableStringify(orig?.names) !== stableStringify(def.names)) {
    putChild(doc, root, "names", writeNames(doc, def.names, def.name), ["kindInformations", "elementInformations", "informations", "description"]);
  }
  if (fresh || stableStringify(orig?.kind) !== stableStringify(def.kind)) {
    putChild(doc, root, "kindInformations", Object.keys(def.kind).length ? writeContext(doc, "kindInformations", "kindInformation", def.kind, true) : null, [
      "elementInformations",
      "informations",
      "description",
    ]);
  }
  if (fresh || stableStringify(orig?.info) !== stableStringify(def.info)) {
    putChild(doc, root, "elementInformations", Object.keys(def.info).length ? writeContext(doc, "elementInformations", "elementInformation", def.info, true) : null, [
      "informations",
      "description",
    ]);
  }
  const informations = def.meta.informations ?? "";
  if (fresh || (orig?.meta.informations ?? "") !== informations) {
    const el = doc.createElement("informations");
    setText(doc, el, informations);
    putChild(doc, root, "informations", informations || !fresh ? el : null, ["description"]);
  }
  if (fresh || stableStringify(orig?.prims) !== stableStringify(def.prims) || stableStringify(orig?.pins) !== stableStringify(def.pins)) {
    const origDesc = fresh ? null : child(root, "description");
    const desc = buildDescription(doc, def, origDesc);
    putChild(doc, root, "description", desc, []);
  }
  if (fresh) formatSubtree(doc, root, 0);
  return serializeXml(doc);
}

/** Build a <definition> element for `def` inside `doc` (used when embedding into a project). */
export function definitionElement(doc: XDocument, def: ElementDef): XElement {
  const src = parseXml(serializeElmt(def)).documentElement as XElement;
  const node = adopt(doc, src);
  if (!isElement(node)) throw new Error("definition import failed");
  return node;
}

/** Local bounding box of the drawing (prims + pins), for sanity checks and placeholder sizing. */
export function primsBBox(def: Pick<ElementDef, "prims" | "pins">): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of def.prims) {
    switch (p.t) {
      case "line":
        add(p.x1, p.y1);
        add(p.x2, p.y2);
        break;
      case "rect":
      case "ellipse":
      case "arc":
        add(p.x, p.y);
        add(p.x + p.w, p.y + p.h);
        break;
      case "polygon":
        p.pts.forEach((q) => add(q.x, q.y));
        break;
      case "text":
      case "dyntext":
        add(p.x, p.y);
        break;
    }
  }
  for (const p of def.pins) add(p.x, p.y);
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export { fmt };
