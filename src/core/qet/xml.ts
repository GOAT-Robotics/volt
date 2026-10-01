// SPDX-License-Identifier: GPL-3.0-or-later
// Part of Volt. Parts of this file re-implement QElectroTech algorithms
// (Copyright 2006-2026 The QElectroTech Team, GPL-2.0-or-later); see NOTICE.md.
/**
 * Small, isomorphic XML helpers on top of @xmldom/xmldom (no DOM globals, so this runs in
 * Node, workers and the browser alike).
 *
 * QElectroTech writes its files with `QDomDocument::toString(4)`: 4-space indentation, no XML
 * prolog. The helpers below keep that layout when nodes are inserted into / removed from a parsed
 * document so a patched file still diffs cleanly against the original.
 */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document as XDocument, Element as XElement, Node as XNode } from "@xmldom/xmldom";

export type { XDocument, XElement, XNode };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const INDENT_UNIT = "    ";

export class QetXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QetXmlError";
  }
}

/**
 * Marker attribute recording that an element was written as `<x></x>` rather than `<x/>`
 * (QDom writes the former for an element holding an empty text node). It never reaches the
 * serialised output and is hidden from `allAttrs()`.
 */
export const EMPTY_PAIR_MARK = "__qet_empty_pair__";
const EMPTY_PAIR_RE = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*><\/\1\s*>/g;

/** Parse an XML string. Throws QetXmlError on malformed input (warnings are ignored). */
export function parseXml(xml: string): XDocument {
  const parser = new DOMParser({
    onError: (level, msg) => {
      if (level !== "warning") throw new QetXmlError(`XML ${level}: ${msg}`);
    },
  });
  // strip a UTF-8 BOM if any
  let src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  src = src.replace(EMPTY_PAIR_RE, (_m, tag: string, attrs: string) => `<${tag}${attrs} ${EMPTY_PAIR_MARK}="1"/>`);
  let doc: XDocument;
  try {
    doc = parser.parseFromString(src, "text/xml");
  } catch (e) {
    if (e instanceof QetXmlError) throw e;
    throw new QetXmlError(e instanceof Error ? e.message : String(e));
  }
  if (!doc.documentElement) throw new QetXmlError("XML document has no root element");
  return doc;
}

/** Parse a fragment whose root is a single element and return that element (owned by its own document). */
export function parseElement(xml: string): XElement {
  const root = parseXml(xml).documentElement;
  if (!root) throw new QetXmlError("empty XML fragment");
  return root;
}

/** QDom's encodeText() (qdom.cpp): what QElectroTech itself writes. */
function qdomEncode(s: string, attrValue: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<") out += "&lt;";
    else if (c === "&") out += "&amp;";
    else if (c === '"' && attrValue) out += "&quot;";
    else if (c === ">" && i >= 2 && s[i - 1] === "]" && s[i - 2] === "]") out += "&gt;";
    else if (attrValue && c === "\n") out += "&#xa;";
    else if (attrValue && c === "\t") out += "&#x9;";
    else if (c === "\r") out += "&#xd;";
    else out += c;
  }
  return out;
}

function serializeInto(node: XNode, out: string[]): void {
  switch (node.nodeType) {
    case ELEMENT_NODE: {
      const el = node as XElement;
      out.push("<", el.tagName);
      const a = el.attributes;
      let emptyPair = false;
      for (let i = 0; i < a.length; i++) {
        const it = a.item(i);
        if (!it) continue;
        if (it.name === EMPTY_PAIR_MARK) {
          emptyPair = true;
          continue;
        }
        out.push(" ", it.name, '="', qdomEncode(it.value, true), '"');
      }
      if (!el.firstChild) {
        out.push(emptyPair ? `></${el.tagName}>` : "/>");
        return;
      }
      out.push(">");
      for (let n: XNode | null = el.firstChild; n; n = n.nextSibling) serializeInto(n, out);
      out.push("</", el.tagName, ">");
      return;
    }
    case TEXT_NODE:
      out.push(qdomEncode(node.nodeValue ?? "", false));
      return;
    case 4: // CDATA
      out.push("<![CDATA[", node.nodeValue ?? "", "]]>");
      return;
    case 7: // processing instruction
      out.push("<?", node.nodeName, " ", node.nodeValue ?? "", "?>");
      return;
    case 8: // comment
      out.push("<!--", node.nodeValue ?? "", "-->");
      return;
    case 9: // document
    case 11: {
      // fragment
      const parts: string[] = [];
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === TEXT_NODE && !/\S/.test(n.nodeValue ?? "")) continue;
        const o: string[] = [];
        serializeInto(n, o);
        parts.push(o.join(""));
      }
      out.push(parts.join("\n"));
      return;
    }
    default:
      out.push(new XMLSerializer().serializeToString(node));
  }
}

/** Serialise like QDomDocument::toString(): QDom escaping rules, `<x></x>` pairs preserved. */
export function serializeXml(node: XNode): string {
  const out: string[] = [];
  serializeInto(node, out);
  return out.join("");
}

export const isElement = (n: XNode | null | undefined): n is XElement => !!n && n.nodeType === ELEMENT_NODE;
const isText = (n: XNode | null | undefined): boolean => !!n && n.nodeType === TEXT_NODE;
const isBlankText = (n: XNode | null | undefined): boolean => isText(n) && !/\S/.test(n!.nodeValue ?? "");

/** Direct element children, optionally filtered by tag name. */
export function children(el: XElement | null | undefined, tag?: string): XElement[] {
  const out: XElement[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) if (isElement(n) && (tag === undefined || n.tagName === tag)) out.push(n);
  return out;
}

export function child(el: XElement | null | undefined, tag: string): XElement | null {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) if (isElement(n) && n.tagName === tag) return n;
  return null;
}

/** `<parent><container><tag/>...</container></parent>` -> tag elements (like QET::findInDomElement(e, container, tag)). */
export function subChildren(el: XElement | null | undefined, container: string, tag: string): XElement[] {
  return children(el, container).flatMap((c) => children(c, tag));
}

export function attr(el: XElement, name: string, def = ""): string {
  return el.hasAttribute(name) ? (el.getAttribute(name) ?? def) : def;
}
export function optAttr(el: XElement, name: string): string | undefined {
  return el.hasAttribute(name) ? (el.getAttribute(name) ?? undefined) : undefined;
}

/** Numeric attribute; returns `def` when missing or not a finite number (QString::toDouble semantics). */
export function num(el: XElement, name: string, def = 0): number {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === "") return def;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : def;
}
export function optNum(el: XElement, name: string): number | undefined {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}
export function int(el: XElement, name: string, def = 0): number {
  const v = el.getAttribute(name);
  if (v === null) return def;
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : def;
}
/** QET booleans are "true"/"false" or "1"/"0". */
export function bool(el: XElement, name: string, def = false): boolean {
  const v = el.getAttribute(name);
  if (v === null || v === "") return def;
  return v === "true" || v === "1";
}

export function allAttrs(el: XElement): Record<string, string> {
  const out: Record<string, string> = {};
  const a = el.attributes;
  for (let i = 0; i < a.length; i++) {
    const it = a.item(i);
    if (it && it.name !== EMPTY_PAIR_MARK) out[it.name] = it.value;
  }
  return out;
}

export function setAttrs(el: XElement, attrs: Record<string, string | number | boolean | undefined | null>): XElement {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) el.removeAttribute(k);
    else el.setAttribute(k, typeof v === "number" ? fmt(v) : String(v));
  }
  return el;
}

export function textOf(el: XElement | null | undefined): string {
  return el?.textContent ?? "";
}

export function setText(doc: XDocument, el: XElement, text: string): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  if (text !== "") el.appendChild(doc.createTextNode(text));
  else el.setAttribute(EMPTY_PAIR_MARK, "1"); // QDom writes an empty text node as <x></x>
}

/** Compact number formatting close to QString::number(double): no trailing zeros, no "-0". */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1e6) / 1e6;
  if (Object.is(r, -0) || r === 0) return "0";
  return String(r);
}

export function createEl(
  doc: XDocument,
  tag: string,
  attrs: Record<string, string | number | boolean | undefined | null> = {},
  kids: (XNode | string)[] = [],
): XElement {
  const el = doc.createElement(tag);
  setAttrs(el, attrs);
  for (const k of kids) el.appendChild(typeof k === "string" ? doc.createTextNode(k) : k);
  return el;
}

/** Import a node from another document (deep). */
export function adopt(doc: XDocument, node: XNode): XNode {
  return doc.importNode(node, true);
}

/* ------------------------------------------------------------------ */
/* Layout-preserving tree edits                                        */
/* ------------------------------------------------------------------ */

/** Nesting depth of an element (root = 0). */
function depth(el: XNode): number {
  let d = 0;
  for (let p = el.parentNode; p && isElement(p); p = p.parentNode) d++;
  return d;
}

/** Whether an element only contains elements/whitespace (i.e. it is safe to re-indent). */
function elementOnly(el: XElement): boolean {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (isText(n) && /\S/.test(n.nodeValue ?? "")) return false;
    if (!isElement(n) && !isText(n)) return false;
  }
  return true;
}

/**
 * Re-indent a (freshly generated) subtree in QDom style so that `el` is at nesting `level`.
 * Elements with text content are left untouched internally.
 */
export function formatSubtree(doc: XDocument, el: XElement, level: number): void {
  const kids = children(el);
  // leaf elements keep their text verbatim (a whitespace-only value is meaningful, cf. QET #973)
  if (!kids.length || !elementOnly(el)) return;
  // drop existing whitespace
  for (let n = el.firstChild; n; ) {
    const next = n.nextSibling;
    if (isBlankText(n)) el.removeChild(n);
    n = next;
  }
  for (const k of kids) {
    el.insertBefore(doc.createTextNode("\n" + INDENT_UNIT.repeat(level + 1)), k);
    formatSubtree(doc, k, level + 1);
  }
  el.appendChild(doc.createTextNode("\n" + INDENT_UNIT.repeat(level)));
}

/**
 * Insert `node` into `parent` (before `ref`, or at the end), adding indentation whitespace that
 * matches the surrounding QDom layout, and formatting the inserted subtree.
 */
export function insertIndented(doc: XDocument, parent: XElement, node: XElement, ref: XNode | null = null): XElement {
  const level = depth(parent) + 1;
  formatSubtree(doc, node, level);
  if (ref) {
    parent.insertBefore(node, ref);
    parent.insertBefore(doc.createTextNode("\n" + INDENT_UNIT.repeat(level)), ref);
    return node;
  }
  const last = parent.lastChild;
  if (last && isBlankText(last)) {
    // "<p>\n    <a/>\n</p>": insert before the closing whitespace, keeping the closing indent
    parent.insertBefore(doc.createTextNode("\n" + INDENT_UNIT.repeat(level)), last);
    parent.insertBefore(node, last);
  } else {
    parent.appendChild(doc.createTextNode("\n" + INDENT_UNIT.repeat(level)));
    parent.appendChild(node);
    parent.appendChild(doc.createTextNode("\n" + INDENT_UNIT.repeat(level - 1)));
  }
  return node;
}

/** Remove a node together with the whitespace text node preceding it. */
export function removeIndented(node: XNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  const prev = node.previousSibling;
  if (prev && isBlankText(prev)) parent.removeChild(prev);
  parent.removeChild(node);
}

/** Replace `oldNode` by `newNode`, formatting `newNode` at the same level. */
export function replaceIndented(doc: XDocument, oldNode: XElement, newNode: XElement): void {
  const parent = oldNode.parentNode;
  if (!parent) return;
  formatSubtree(doc, newNode, depth(oldNode));
  parent.replaceChild(newNode, oldNode);
}

/** Ensure an element child exists; created (indented) before the first of `beforeTags` found, else appended. */
export function ensureChild(doc: XDocument, parent: XElement, tag: string, beforeTags: string[] = []): XElement {
  const found = child(parent, tag);
  if (found) return found;
  const el = doc.createElement(tag);
  let ref: XElement | null = null;
  for (const t of beforeTags) {
    ref = child(parent, t);
    if (ref) break;
  }
  return insertIndented(doc, parent, el, ref);
}

/** Remove all whitespace-only text children of an element whose element children were all removed. */
export function collapseIfEmpty(el: XElement): void {
  if (children(el).length) return;
  for (let n = el.firstChild; n; ) {
    const next = n.nextSibling;
    if (isBlankText(n)) el.removeChild(n);
    n = next;
  }
}

/* ------------------------------------------------------------------ */
/* QET specific value helpers                                          */
/* ------------------------------------------------------------------ */

/** QFont::toString(): "family,pointSizeF,pixelSize,styleHint,weight,style,..." */
export function parseQtFont(s: string | undefined): { family?: string; size?: number; bold?: boolean; italic?: boolean } {
  if (!s) return {};
  const p = s.split(",");
  const size = Number(p[1]);
  const weight = Number(p[4]);
  const style = Number(p[5]);
  return {
    family: p[0] || undefined,
    size: Number.isFinite(size) && size > 0 ? size : undefined,
    // Qt5 weights: 50 normal / 75 bold; Qt6: 400 / 700
    bold: Number.isFinite(weight) ? weight >= 63 && (weight < 100 || weight >= 600) : undefined,
    italic: Number.isFinite(style) ? style === 1 : undefined,
  };
}

export function qtFontString(family: string, size: number, bold = false, italic = false): string {
  return `${family},${fmt(size)},-1,5,${bold ? 75 : 50},${italic ? 1 : 0},0,0,0,0`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** QGraphicsTextItem::toHtml() -> plain text (for independent texts); plain input is returned as-is. */
export function htmlToPlain(s: string): string {
  if (!/<\s*(html|body|p|br|span|!DOCTYPE)/i.test(s)) return s;
  let t = s;
  t = t.replace(/<head[\s\S]*?<\/head>/gi, "");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, "");
  t = t.replace(/<!DOCTYPE[^>]*>/gi, "");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/p>\s*/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return t.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function plainToHtmlIfNeeded(s: string): string {
  // QGraphicsTextItem::setHtml() collapses newlines of plain text, so encode multi-line text as HTML.
  if (!s.includes("\n")) return s;
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<html><body><p>${esc.split("\n").join("<br/>")}</p></body></html>`;
}

/** "{uuid}" -> "uuid" lower-cased (QUuid comparison is case-insensitive). */
export const normUuid = (s: string | null | undefined): string => (s ?? "").trim().replace(/^\{|\}$/g, "").toLowerCase();
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normUuid(s));
export const bracedUuid = (s: string): string => `{${normUuid(s)}}`;
