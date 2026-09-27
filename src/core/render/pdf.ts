import {
  PDFDocument,
  PDFPage,
  PDFFont,
  StandardFonts,
  LineCapStyle,
  LineJoinStyle,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  stroke as opStroke,
  fill as opFill,
  setLineWidth,
  setStrokingRgbColor,
  setFillingRgbColor,
  setDashPattern,
  setLineCap,
  setLineJoin,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
  rectangle,
  PDFName,
  PDFNull,
  PDFHexString,
  drawObject,
  type PDFImage,
} from "pdf-lib";
import { base64ToBytes, base64ToText, logoKey, logoSize } from "../logos";
import { templateLogos } from "../qet/titleblock";
import { buildXref, describe, targetsOf } from "../xref";
import type { Mat } from "../geometry";
import type { Doc, Page, Rect } from "../model";
import type { ImageDraw, Painter, PathData, StrokeStyle, TextDraw } from "./painter";
import { ellipsePt } from "./painter";
import { drawPage, pageGeometry, tbTemplate, type DrawOpts } from "./scene";

function rgb(color: string, alpha = 1): [number, number, number] | null {
  if (!color || color === "transparent" || color === "none") return null;
  let r = 0, g = 0, b = 0;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (m) {
    const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
    r = parseInt(h.slice(0, 2), 16) / 255;
    g = parseInt(h.slice(2, 4), 16) / 255;
    b = parseInt(h.slice(4, 6), 16) / 255;
  }
  // flatten alpha against white paper
  return [1 - (1 - r) * alpha, 1 - (1 - g) * alpha, 1 - (1 - b) * alpha];
}

/** Emit a cubic-bezier approximation of an elliptic arc. */
function arcOps(cx: number, cy: number, rx: number, ry: number, a0: number, sweep: number, first: boolean) {
  const ops = [];
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const d = sweep / n;
  const k = (4 / 3) * Math.tan(d / 4);
  let a = a0;
  const s = ellipsePt(cx, cy, rx, ry, a);
  if (first) ops.push(moveTo(s.x, s.y));
  for (let i = 0; i < n; i++) {
    const c1 = Math.cos(a), s1 = Math.sin(a), c2 = Math.cos(a + d), s2 = Math.sin(a + d);
    ops.push(
      appendBezierCurve(cx + rx * (c1 - k * s1), cy + ry * (s1 + k * c1), cx + rx * (c2 + k * s2), cy + ry * (s2 - k * c2), cx + rx * c2, cy + ry * s2),
    );
    a += d;
  }
  return ops;
}

function pathOps(p: PathData) {
  const out = [];
  for (const op of p.ops) {
    switch (op[0]) {
      case "M":
        out.push(moveTo(op[1], op[2]));
        break;
      case "L":
        out.push(lineTo(op[1], op[2]));
        break;
      case "Z":
        out.push(closePath());
        break;
      case "R":
      case "RR":
        out.push(rectangle(op[1], op[2], op[3], op[4]));
        break;
      case "E":
        out.push(...arcOps(op[1], op[2], op[3], op[4], 0, Math.PI * 2, true), closePath());
        break;
      case "A": {
        const [, cx, cy, rx, ry, a0, a1, ccw] = op;
        let sweep = a1 - a0;
        if (ccw && sweep > 0) sweep -= Math.PI * 2;
        if (!ccw && sweep < 0) sweep += Math.PI * 2;
        out.push(...arcOps(cx, cy, rx, ry, a0, sweep, true));
        break;
      }
    }
  }
  return out;
}

const WINANSI_EXTRA: Record<string, string> = { "Ω": "Ohm", "−": "-", "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "✓": "v", "…": "..." };
function sanitize(font: PDFFont, s: string): string {
  let out = "";
  for (const ch of s) {
    const rep = WINANSI_EXTRA[ch];
    if (rep) {
      out += rep;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

export class PdfPainter implements Painter {
  readonly kind = "pdf" as const;
  private fontKeys = new Map<PDFFont, PDFName>();
  private imageKeys = new Map<string, PDFName>();
  constructor(
    private page: PDFPage,
    private fonts: { regular: PDFFont; bold: PDFFont; italic: PDFFont },
    private images: Map<string, PDFImage> = new Map(),
  ) {}
  image(d: ImageDraw) {
    const img = this.images.get(d.key);
    if (!img || d.w <= 0 || d.h <= 0) return;
    let name = this.imageKeys.get(d.key);
    if (!name) {
      name = this.page.node.newXObject("Img", img.ref);
      this.imageKeys.set(d.key, name);
    }
    // unit square → box; the scene is y-down, the image's top edge is v = 1
    this.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(d.w, 0, 0, -d.h, d.x, d.y + d.h), drawObject(name), popGraphicsState());
  }
  save() {
    this.page.pushOperators(pushGraphicsState());
  }
  restore() {
    this.page.pushOperators(popGraphicsState());
  }
  transform(m: Mat) {
    this.page.pushOperators(concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  }
  scale() {
    return 100;
  }
  stroke(p: PathData, s: StrokeStyle) {
    const c = rgb(s.color, s.alpha ?? 1);
    if (!c || !p.ops.length) return;
    this.page.pushOperators(
      pushGraphicsState(),
      setStrokingRgbColor(...c),
      setLineWidth(Math.max(s.width, 0.35)),
      setLineCap(s.cap === "round" ? LineCapStyle.Round : s.cap === "square" ? LineCapStyle.Projecting : LineCapStyle.Butt),
      setLineJoin(s.join === "round" ? LineJoinStyle.Round : s.join === "bevel" ? LineJoinStyle.Bevel : LineJoinStyle.Miter),
      setDashPattern(s.dash ? s.dash.map((d) => d * Math.max(1, s.width)) : [], 0),
      ...pathOps(p),
      opStroke(),
      popGraphicsState(),
    );
  }
  fill(p: PathData, color: string, alpha?: number) {
    const c = rgb(color, alpha ?? 1);
    if (!c || !p.ops.length) return;
    this.page.pushOperators(pushGraphicsState(), setFillingRgbColor(...c), ...pathOps(p), opFill(), popGraphicsState());
  }
  private key(font: PDFFont) {
    let k = this.fontKeys.get(font);
    if (!k) {
      k = this.page.node.newFontDictionary(font.name, font.ref);
      this.fontKeys.set(font, k);
    }
    return k;
  }
  text(t: TextDraw) {
    const font = (t.weight ?? 400) >= 600 ? this.fonts.bold : t.italic ? this.fonts.italic : this.fonts.regular;
    const str = sanitize(font, t.text);
    if (!str) return;
    const c = rgb(t.color, t.alpha ?? 1);
    if (!c) return;
    const w = font.widthOfTextAtSize(str, t.size);
    let dx = t.align === "center" ? -w / 2 : t.align === "right" ? -w : 0;
    const asc = t.size * 0.76;
    let dy = t.baseline === "top" ? asc : t.baseline === "middle" ? t.size * 0.36 : t.baseline === "bottom" ? -t.size * 0.22 : 0;
    const a = ((t.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const ox = t.x + cos * dx - sin * dy;
    const oy = t.y + sin * dx + cos * dy;
    if (t.background) {
      const bg = rgb(t.background);
      if (bg) {
        const top = -asc;
        this.page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(cos, sin, -sin, cos, ox, oy),
          setFillingRgbColor(...bg),
          rectangle(-1, top - 0.5, w + 2, t.size * 1.15),
          opFill(),
          popGraphicsState(),
        );
      }
    }
    dx = 0;
    dy = 0;
    this.page.pushOperators(
      beginText(),
      setFillingRgbColor(...c),
      setFontAndSize(this.key(font), t.size),
      setTextMatrix(cos, sin, sin, -cos, ox, oy),
      showText(font.encodeText(str)),
      endText(),
    );
  }
  measure(text: string, size: number, _font: string, weight?: number) {
    const f = (weight ?? 400) >= 600 ? this.fonts.bold : this.fonts.regular;
    try {
      return f.widthOfTextAtSize(sanitize(f, text), size);
    } catch {
      return text.length * size * 0.55;
    }
  }
}

export const PAPER: Record<string, [number, number]> = {
  A4: [841.89, 595.28],
  A3: [1190.55, 841.89],
  A2: [1683.78, 1190.55],
  A1: [2383.94, 1683.78],
  Letter: [792, 612],
  Tabloid: [1224, 792],
};

export type PdfExportOptions = {
  pages: Page[];
  paper?: keyof typeof PAPER | "fit";
  margin?: number; // pt
  title?: string;
  subject?: string;
  keywords?: string[];
  author?: string;
  version?: string;
  drawOpts?: Partial<DrawOpts>;
  bounds?: (p: Page) => Rect;
  /** extra drawing on top of each page, in scene coordinates */
  overlay?: (p: Painter, page: Page) => void;
  /** callback to append extra pages (e.g. signature evidence) */
  append?: (pdf: PDFDocument, fonts: { regular: PDFFont; bold: PDFFont; italic: PDFFont }) => Promise<void> | void;
  deterministic?: boolean;
  /** clickable cross-reference links between labels (default true) */
  links?: boolean;
  /** turns an SVG logo into PNG bytes (browser: canvas; server: sharp); SVG logos are skipped without it */
  rasterizeSvg?: (svg: string, w: number, h: number) => Promise<Uint8Array | null>;
};

/** Embeds the title block logos used by the exported pages, keyed like ImageDraw.key. */
async function embedLogos(pdf: PDFDocument, doc: Doc, pages: Page[], raster: PdfExportOptions["rasterizeSvg"]) {
  const out = new Map<string, PDFImage>();
  for (const page of pages) {
    if (!page.titleBlock.show) continue;
    for (const logo of Object.values(templateLogos(tbTemplate(doc, page)))) {
      const key = logoKey(logo);
      if (out.has(key)) continue;
      try {
        if (logo.type === "png") out.set(key, await pdf.embedPng(base64ToBytes(logo.data)));
        else if (logo.type === "jpg") out.set(key, await pdf.embedJpg(base64ToBytes(logo.data)));
        else if (raster) {
          const n = logoSize(logo) ?? { w: 100, h: 100 };
          const k = Math.min(8, 1200 / Math.max(n.w, n.h));
          const png = await raster(base64ToText(logo.data), Math.max(1, Math.round(n.w * k)), Math.max(1, Math.round(n.h * k)));
          if (png) out.set(key, await pdf.embedPng(png));
        }
      } catch {
        /* unreadable image: the cell stays empty */
      }
    }
  }
  return out;
}

/** Vector PDF export; one PDF page per drawing page, scaled to fit the paper. */
export async function exportPdf(doc: Doc, o: PdfExportOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const sorted = [...doc.pages].sort((a, b) => a.order - b.order);
  const placed = new Map<string, { pp: PDFPage; s: number; ox: number; oy: number; H: number; W: number }>();
  const images = await embedLogos(pdf, doc, o.pages, o.rasterizeSvg);
  for (const page of o.pages) {
    const r = o.bounds?.(page) ?? pageGeometry(doc, page).total;
    const margin = o.margin ?? 18;
    let W: number, H: number;
    if (!o.paper || o.paper === "fit") {
      W = r.w + margin * 2;
      H = r.h + margin * 2;
    } else {
      [W, H] = PAPER[o.paper];
      if (r.h > r.w) [W, H] = [H, W];
    }
    const s = Math.min((W - margin * 2) / r.w, (H - margin * 2) / r.h);
    const pp = pdf.addPage([W, H]);
    const ox = (W - r.w * s) / 2 - r.x * s;
    const oy = H - ((H - r.h * s) / 2 - r.y * s);
    const painter = new PdfPainter(pp, fonts, images);
    painter.save();
    // scene (y-down) → PDF (y-up)
    painter.transform([s, 0, 0, -s, ox, oy]);
    drawPage(painter, { doc, page, lod: 100, pageIndex: sorted.findIndex((p) => p.id === page.id), pageCount: sorted.length, version: o.version, ...(o.drawOpts ?? {}) });
    o.overlay?.(painter, page);
    painter.restore();
    placed.set(page.id, { pp, s, ox, oy, H, W });
  }
  if (o.links !== false) addCrossReferenceLinks(pdf, doc, placed, fonts);
  if (o.append) await o.append(pdf, fonts);
  pdf.setTitle(o.title ?? doc.meta.title);
  if (o.subject) pdf.setSubject(o.subject);
  if (o.author) pdf.setAuthor(o.author);
  if (o.keywords) pdf.setKeywords(o.keywords);
  pdf.setProducer("Volt");
  pdf.setCreator("Volt electrical diagram editor");
  if (o.deterministic) {
    const d = new Date(0);
    pdf.setCreationDate(d);
    pdf.setModificationDate(d);
  }
  return pdf.save({ useObjectStreams: !o.deterministic });
}

/**
 * Internal link annotations: each label (component reference, wire number, QET report/link)
 * jumps to the next occurrence of the same label that is part of this PDF.
 */
function addCrossReferenceLinks(
  pdf: PDFDocument,
  doc: Doc,
  placed: Map<string, { pp: PDFPage; s: number; ox: number; oy: number; H: number; W: number }>,
  fonts: { regular: PDFFont; bold: PDFFont },
) {
  const measure = (text: string, size: number, _font: string, weight?: number) => {
    const f = (weight ?? 400) >= 600 ? fonts.bold : fonts.regular;
    try {
      return f.widthOfTextAtSize(sanitize(f, text), size);
    } catch {
      return text.length * size * 0.55;
    }
  };
  const x = buildXref(doc, measure);
  const toPdf = (m: { s: number; ox: number; oy: number }, p: { x: number; y: number }) => ({ x: m.ox + m.s * p.x, y: m.oy - m.s * p.y });
  for (const occ of x.occ) {
    if (occ.group < 0) continue;
    const src = placed.get(occ.pageId);
    if (!src) continue;
    const target = targetsOf(x, occ).find((t) => placed.has(t.pageId));
    if (!target) continue;
    const dst = placed.get(target.pageId)!;
    const tp = toPdf(dst, target.at);
    const left = Math.max(0, tp.x - 120);
    const top = Math.min(dst.H, tp.y + 90);
    const label = describe(doc, target);
    for (const r of occ.hit) {
      const a = toPdf(src, { x: r.x, y: r.y + r.h });
      const b = toPdf(src, { x: r.x + r.w, y: r.y });
      const annot = pdf.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [a.x - 1, a.y - 1, b.x + 1, b.y + 1],
        Border: [0, 0, 0],
        H: "I",
        Contents: PDFHexString.fromText(`Go to ${label}`),
        Dest: [dst.pp.ref, PDFName.of("XYZ"), left, top, PDFNull],
      });
      src.pp.node.addAnnot(pdf.context.register(annot));
    }
  }
}
