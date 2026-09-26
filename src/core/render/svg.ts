import type { Mat } from "../geometry";
import type { Doc, Page, Rect } from "../model";
import type { Painter, PathData, StrokeStyle, TextDraw } from "./painter";
import { pathToSvgD } from "./painter";
import { drawPage, pageGeometry, type DrawOpts } from "./scene";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n: number) => String(Math.round(n * 100) / 100);

/** Approximate text metrics when no canvas is available (Helvetica-like average widths). */
export function approxMeasure(text: string, size: number, _font?: string, weight = 400): number {
  let w = 0;
  for (const ch of text) {
    if ("il.,:;|!'".includes(ch)) w += 0.28;
    else if ("mwMW".includes(ch)) w += 0.85;
    else if (ch >= "A" && ch <= "Z") w += 0.66;
    else if (ch >= "0" && ch <= "9") w += 0.56;
    else if (ch === " ") w += 0.28;
    else w += 0.52;
  }
  return w * size * (weight >= 600 ? 1.05 : 1);
}

export class SvgPainter implements Painter {
  readonly kind = "svg" as const;
  out: string[] = [];
  constructor(private measureFn: Painter["measure"] = approxMeasure) {}
  private opens: number[] = [0];
  save() {
    this.opens.push(0);
  }
  restore() {
    const n = this.opens.pop() ?? 0;
    for (let i = 0; i < n; i++) this.out.push("</g>");
  }
  transform(m: Mat) {
    this.out.push(`<g transform="matrix(${m.map(f).join(" ")})">`);
    this.opens[this.opens.length - 1]++;
  }
  scale() {
    return 100;
  }
  stroke(p: PathData, s: StrokeStyle) {
    if (!p.ops.length) return;
    this.out.push(
      `<path d="${pathToSvgD(p, f)}" fill="none" stroke="${s.color}" stroke-width="${f(s.width)}"${s.dash ? ` stroke-dasharray="${s.dash.map((d) => f(d * Math.max(1, s.width))).join(" ")}"` : ""} stroke-linecap="${s.cap ?? "butt"}" stroke-linejoin="${s.join ?? "miter"}"${s.alpha !== undefined && s.alpha !== 1 ? ` opacity="${s.alpha}"` : ""}/>`,
    );
  }
  fill(p: PathData, color: string, alpha?: number) {
    if (!p.ops.length) return;
    this.out.push(`<path d="${pathToSvgD(p, f)}" fill="${color}" stroke="none"${alpha !== undefined && alpha !== 1 ? ` fill-opacity="${alpha}"` : ""}/>`);
  }
  text(t: TextDraw) {
    const anchor = t.align === "center" ? "middle" : t.align === "right" ? "end" : "start";
    const base = t.baseline === "top" ? "text-before-edge" : t.baseline === "middle" ? "central" : t.baseline === "bottom" ? "text-after-edge" : "alphabetic";
    const tr = t.rotation ? ` transform="rotate(${f(t.rotation)} ${f(t.x)} ${f(t.y)})"` : "";
    if (t.background) {
      const w = this.measure(t.text, t.size, t.font, t.weight);
      const ax = t.align === "center" ? t.x - w / 2 : t.align === "right" ? t.x - w : t.x;
      const ay = t.baseline === "top" ? t.y : t.baseline === "middle" ? t.y - t.size / 2 : t.y - t.size * 0.8;
      this.out.push(`<rect x="${f(ax - 1)}" y="${f(ay - 0.5)}" width="${f(w + 2)}" height="${f(t.size * 1.15)}" fill="${t.background}"${tr}/>`);
    }
    this.out.push(
      `<text x="${f(t.x)}" y="${f(t.y)}" font-family="${esc(t.font)}" font-size="${f(t.size)}" font-weight="${t.weight ?? 400}"${t.italic ? ' font-style="italic"' : ""} fill="${t.color}" text-anchor="${anchor}" dominant-baseline="${base}"${tr}${t.alpha !== undefined && t.alpha !== 1 ? ` opacity="${t.alpha}"` : ""} xml:space="preserve">${esc(t.text)}</text>`,
    );
  }
  measure(text: string, size: number, font: string, weight?: number) {
    return this.measureFn(text, size, font, weight);
  }
  begin(layer: string) {
    this.out.push(`<g id="${layer}-${this.out.length}" data-layer="${layer}">`);
  }
  end() {
    this.out.push("</g>");
  }
}

/** Render a page to a standalone SVG document. */
export function pageToSvg(doc: Doc, page: Page, opts: Partial<DrawOpts> & { measure?: Painter["measure"]; background?: string; bounds?: Rect } = {}): string {
  const p = new SvgPainter(opts.measure);
  const r = opts.bounds ?? pageGeometry(doc, page).total;
  const pad = 10;
  drawPage(p, { doc, page, lod: 100, ...opts });
  const vb = `${f(r.x - pad)} ${f(r.y - pad)} ${f(r.w + 2 * pad)} ${f(r.h + 2 * pad)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${f(r.w + 2 * pad)}" height="${f(r.h + 2 * pad)}">\n<title>${esc(page.title)}</title>\n${opts.background ? `<rect x="${f(r.x - pad)}" y="${f(r.y - pad)}" width="${f(r.w + 2 * pad)}" height="${f(r.h + 2 * pad)}" fill="${opts.background}"/>` : ""}${p.out.join("\n")}\n</svg>\n`;
}
