"use client";
/** Draw laid-out labels: preview canvases, 1-bit printer bitmaps, PNG/PDF pages. */
import type { LaidLabel, LabelMedia, Measure } from "@/core/labels";
import { headArea, mmToDots, PT_DPI, type PtBitmap } from "@/core/ptouch";

const FONT = `"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif`;
const font = (px: number, bold: boolean) => `${bold ? 700 : 500} ${px}px ${FONT}`;

let mctx: CanvasRenderingContext2D | null = null;
export const canvasMeasure: Measure = (t, s, b) => {
  if (!mctx) mctx = document.createElement("canvas").getContext("2d");
  if (!mctx) return t.length * s * 0.6;
  mctx.font = font(100, b);
  return (mctx.measureText(t).width / 100) * s;
};

/** draw at `pxPerMm`; y0 = top of the printable band in px */
export function drawLabel(ctx: CanvasRenderingContext2D, l: LaidLabel, pxPerMm: number, y0 = 0, pxPerMmY = pxPerMm) {
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (const it of l.items) {
    ctx.save();
    ctx.font = font(it.size * pxPerMmY, it.bold);
    const x = it.x * pxPerMm, y = y0 + it.y * pxPerMmY;
    if (it.rot180) {
      // turn around the centre of the printable band so the folded half reads the same way
      const cy = y0 + (l.height / 2) * pxPerMmY;
      ctx.translate(x, cy);
      ctx.rotate(Math.PI);
      ctx.fillText(it.text, 0, y - cy, it.maxWidth * pxPerMm);
    } else ctx.fillText(it.text, x, y, it.maxWidth * pxPerMm);
    ctx.restore();
  }
}

/** preview / PDF image: the full tape width (unprintable edges white), with the label outline */
export function labelCanvas(l: LaidLabel, media: LabelMedia, pxPerMm: number, opts: { border?: boolean; cutMarks?: boolean } = {}) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(l.length * pxPerMm));
  c.height = Math.max(1, Math.round(media.width * pxPerMm));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  const y0 = ((media.width - media.printable) / 2) * pxPerMm;
  drawLabel(ctx, l, pxPerMm, y0);
  if (opts.cutMarks)
    for (const x of l.cutMarks) {
      ctx.strokeStyle = "#999";
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x * pxPerMm, 0);
      ctx.lineTo(x * pxPerMm, c.height);
      ctx.stroke();
    }
  if (opts.border) {
    ctx.setLineDash([]);
    ctx.strokeStyle = "#bbb";
    ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
  }
  return c;
}

/** 1-bit bitmap for the printer head (180 dpi; the printable band mapped onto the tape's pins) */
export function labelBitmap(l: LaidLabel, media: LabelMedia): PtBitmap {
  const area = headArea(media.brotherWidth, media.kind === "heatshrink");
  const length = Math.max(1, mmToDots(l.length));
  const c = document.createElement("canvas");
  c.width = length;
  c.height = area.pins;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  const pxX = PT_DPI / 25.4;
  const pxY = area.pins / l.height;
  drawLabel(ctx, l, pxX, 0, pxY);
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  const bits = new Uint8Array(length * area.pins);
  for (let x = 0; x < length; x++)
    for (let y = 0; y < area.pins; y++) {
      const i = (y * c.width + x) * 4;
      if (img[i] + img[i + 1] + img[i + 2] < 384) bits[x * area.pins + y] = 1;
    }
  return { length, pins: area.pins, bits };
}
