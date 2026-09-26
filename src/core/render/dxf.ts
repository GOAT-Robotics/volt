import type { Mat } from "../geometry";
import { applyMat, mulMat } from "../geometry";
import type { Doc, Page } from "../model";
import type { Painter, PathData, StrokeStyle, TextDraw } from "./painter";
import { flattenPath } from "./painter";
import { approxMeasure } from "./svg";
import { drawPage } from "./scene";

/** AutoCAD colour index closest to a hex colour (basic palette). */
function aci(color: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return 7;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const pal: [number, number, number, number][] = [
    [1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255], [7, 0, 0, 0], [8, 128, 128, 128], [30, 255, 127, 0],
  ];
  let best = 7, bd = Infinity;
  for (const [i, pr, pg, pb] of pal) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bd) (bd = d), (best = i);
  }
  return best;
}

/** DXF R12 ASCII writer (LINE / POLYLINE / TEXT on layers). Y axis flipped (DXF is y-up). */
export class DxfPainter implements Painter {
  readonly kind = "dxf" as const;
  private m: Mat = [1, 0, 0, -1, 0, 0];
  private stack: Mat[] = [];
  private layer = "0";
  layers = new Set<string>(["0"]);
  ents: string[] = [];
  save() {
    this.stack.push(this.m);
  }
  restore() {
    this.m = this.stack.pop() ?? this.m;
  }
  transform(t: Mat) {
    this.m = mulMat(this.m, t);
  }
  scale() {
    return 100;
  }
  begin(layer: string) {
    this.layer = layer.toUpperCase();
    this.layers.add(this.layer);
  }
  end() {
    this.layer = "0";
  }
  private poly(pts: { x: number; y: number }[], closed: boolean, color: string) {
    const P = pts.map((p) => applyMat(this.m, p));
    if (P.length === 2 && !closed) {
      this.ents.push(`0\nLINE\n8\n${this.layer}\n62\n${aci(color)}\n10\n${P[0].x}\n20\n${P[0].y}\n30\n0\n11\n${P[1].x}\n21\n${P[1].y}\n31\n0`);
      return;
    }
    this.ents.push(`0\nPOLYLINE\n8\n${this.layer}\n62\n${aci(color)}\n66\n1\n70\n${closed ? 1 : 0}`);
    for (const p of P) this.ents.push(`0\nVERTEX\n8\n${this.layer}\n10\n${p.x}\n20\n${p.y}\n30\n0`);
    this.ents.push(`0\nSEQEND\n8\n${this.layer}`);
  }
  stroke(p: PathData, s: StrokeStyle) {
    for (const pl of flattenPath(p)) if (pl.pts.length > 1) this.poly(pl.pts, pl.closed, s.color);
  }
  fill(p: PathData, color: string) {
    for (const pl of flattenPath(p)) if (pl.pts.length > 2) this.poly(pl.pts, true, color);
  }
  text(t: TextDraw) {
    const w = approxMeasure(t.text, t.size);
    const dx = t.align === "center" ? -w / 2 : t.align === "right" ? -w : 0;
    const dy = t.baseline === "top" ? t.size * 0.8 : t.baseline === "middle" ? t.size * 0.35 : 0;
    const a = ((t.rotation ?? 0) * Math.PI) / 180;
    const local = { x: t.x + Math.cos(a) * dx - Math.sin(a) * dy, y: t.y + Math.sin(a) * dx + Math.cos(a) * dy };
    const p = applyMat(this.m, local);
    // rotation in DXF is CCW; our matrix may include rotation of the element
    const v = applyMat(this.m, { x: local.x + Math.cos(a), y: local.y + Math.sin(a) });
    const ang = (Math.atan2(v.y - p.y, v.x - p.x) * 180) / Math.PI;
    const txt = t.text.replace(/\n/g, " ");
    this.ents.push(`0\nTEXT\n8\n${this.layer}\n62\n${aci(t.color)}\n10\n${p.x}\n20\n${p.y}\n30\n0\n40\n${t.size * 0.72}\n1\n${txt}\n50\n${ang}`);
  }
  measure(text: string, size: number) {
    return approxMeasure(text, size);
  }
  toString() {
    const layers = [...this.layers].map((l) => `0\nLAYER\n2\n${l}\n70\n0\n62\n7\n6\nCONTINUOUS`).join("\n");
    return `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${this.layers.size}\n${layers}\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${this.ents.join("\n")}\n0\nENDSEC\n0\nEOF\n`;
  }
}

export function pageToDxf(doc: Doc, page: Page, unitMm = 0.25): string {
  const p = new DxfPainter();
  p.transform([unitMm, 0, 0, unitMm, 0, 0]);
  drawPage(p, { doc, page, lod: 100 });
  return p.toString();
}
