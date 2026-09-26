/** Isomorphic SVG previews for library elements (.elmt) and blocks (BlockContent). */
import type { BlockContent, ElemInst, ElementDef, Rect } from "@/core/model";
import { parseElmt } from "@/core/qet/elmt";
import { defaultStyles } from "@/core/styles";
import { drawElement, layoutElementTexts, layoutPinTexts, textBounds } from "@/core/render/scene";
import { SvgPainter, approxMeasure, pageToSvg } from "@/core/render/svg";
import { symbolFor } from "@/core/render/symbol";
import { newDoc, newPage } from "@/core/doc";
import { symbolBounds, unionR } from "./elmt-tools";

const f = (n: number) => String(Math.round(n * 100) / 100);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type PreviewOpts = { label?: string; pinNumbers?: boolean; pad?: number; title?: string };

export function elementSvg(def: ElementDef, o: PreviewOpts = {}): string {
  const styles = defaultStyles();
  styles.text.pinNumber.visible = o.pinNumbers ?? false;
  const inst: ElemInst = { id: "preview", defId: def.id, x: 0, y: 0, rot: 0, mirror: false, info: { ...def.info, label: o.label ?? "" }, texts: [], showPinNumbers: o.pinNumbers ?? false };
  const p = new SvgPainter(approxMeasure);
  drawElement(p, inst, def, styles, { lod: 100, pins: false, measure: approxMeasure });
  let r: Rect | null = symbolBounds(def);
  // include laid-out dynamic texts actually drawn
  for (const t of layoutElementTexts(inst, symbolFor(def), styles, approxMeasure)) r = unionR(r, textBounds(t));
  if (o.pinNumbers) for (const pin of def.pins) for (const t of layoutPinTexts(inst, pin, styles, true, false, approxMeasure)) r = unionR(r, textBounds(t));
  if (!r || !Number.isFinite(r.x)) r = { x: -10, y: -10, w: 20, h: 20 };
  const pad = o.pad ?? 3;
  const x = r.x - pad, y = r.y - pad, w = Math.max(r.w + 2 * pad, 8), h = Math.max(r.h + 2 * pad, 8);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" width="${f(w * 2)}" height="${f(h * 2)}">${o.title ? `<title>${esc(o.title)}</title>` : ""}${p.out.join("")}</svg>`;
}

export function elmtSvg(xml: string, o: PreviewOpts = {}): string {
  const def = parseElmt(xml, { id: "preview" });
  return elementSvg(def, { title: def.names.en ?? def.name, ...o });
}

export function blockSvg(content: BlockContent, title = "Block"): string {
  const doc = newDoc(title);
  doc.defs = content.defs ?? {};
  const page = newPage(0, title);
  page.border.show = false;
  page.titleBlock.show = false;
  page.elements = content.elements ?? [];
  page.wires = content.wires ?? [];
  page.junctions = content.junctions ?? [];
  page.texts = content.texts ?? [];
  let b: Rect | null = content.bbox && content.bbox.w > 0 ? content.bbox : null;
  if (!b) {
    for (const e of page.elements) {
      const d = doc.defs[e.defId];
      if (d) b = unionR(b, { x: e.x - d.hotspotX, y: e.y - d.hotspotY, w: d.width, h: d.height });
    }
    for (const w of page.wires) for (const p of w.pts) b = unionR(b, { x: p.x, y: p.y, w: 0, h: 0 });
  }
  const svg = pageToSvg(doc, page, { decor: false, bounds: b ?? { x: 0, y: 0, w: 100, h: 60 }, measure: approxMeasure, lod: 100 });
  // ports as small markers
  const ports = (content.ports ?? [])
    .map((p) => `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="2.2" fill="none" stroke="#2563eb" stroke-width="0.8"/><text x="${f(p.x - 3)}" y="${f(p.y + 8)}" font-size="6" text-anchor="end" fill="#2563eb" font-family="Helvetica, Arial, sans-serif">${esc(p.name)}</text>`)
    .join("");
  return svg.replace(/<\/svg>\s*$/, `${ports}</svg>\n`);
}

/** Error placeholder */
export function errorSvg(message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40" width="120" height="80"><rect x="1" y="1" width="58" height="38" rx="3" fill="none" stroke="#dc2626" stroke-dasharray="3 2"/><text x="30" y="23" font-size="7" text-anchor="middle" fill="#dc2626" font-family="Helvetica, Arial, sans-serif">${esc(message.slice(0, 24))}</text></svg>`;
}
