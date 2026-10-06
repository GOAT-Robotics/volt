"use client";
/** Label files: tape PDF (one page per label, for the Brother driver / any label printer), A4 sheet PDF, CSV for P-touch Editor. */
import type { LaidLabel, LabelMedia, LabelRecord, LabelContent } from "@/core/labels";
import { detailLine } from "@/core/labels";
import { labelCanvas } from "./render";

const PT_PER_MM = 72 / 25.4;
const PX_PER_MM = 14; // ≈ 356 dpi

async function png(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** one page per label, page size = label (length × tape width): print with the printer's own driver at 100 % */
export async function tapePdf(labels: LaidLabel[], media: LabelMedia, title: string): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Wire labels — ${title}`);
  pdf.setCreator("Volt");
  for (const l of labels) {
    const img = await pdf.embedPng(await png(labelCanvas(l, media, PX_PER_MM)));
    const w = l.length * PT_PER_MM, h = media.width * PT_PER_MM;
    const page = pdf.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return pdf.save();
}

/** A4 sheet at real size with cut outlines and a caption, sorted for assembly */
export async function sheetPdf(labels: LaidLabel[], recs: LabelRecord[], media: LabelMedia, title: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Wire labels — ${title}`);
  pdf.setCreator("Volt");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 210, H = 297, M = 10, gapX = 4, cap = 3.2, gapY = 2.5;
  let page = pdf.addPage([W * PT_PER_MM, H * PT_PER_MM]);
  let pageNo = 1;
  const header = () => {
    page.drawText(`Wire labels — ${title}`.replace(/[^\x20-\x7e]/g, "-"), { x: M * PT_PER_MM, y: (H - 7) * PT_PER_MM, size: 9, font: bold });
    page.drawText(`${media.name.replace(/[^\x20-\x7e]/g, "-")} · ${labels.length} labels · page ${pageNo}`, { x: M * PT_PER_MM, y: (H - 10.5) * PT_PER_MM, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
  };
  header();
  let x = M, y = H - 15; // top of the next row (mm)
  const rowH = media.width + cap + gapY;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (x + l.length > W - M && x > M) ((x = M), (y -= rowH));
    if (y - rowH < M) {
      page = pdf.addPage([W * PT_PER_MM, H * PT_PER_MM]);
      pageNo++;
      header();
      x = M;
      y = H - 15;
    }
    const img = await pdf.embedPng(await png(labelCanvas(l, media, PX_PER_MM)));
    const by = y - media.width;
    page.drawImage(img, { x: x * PT_PER_MM, y: by * PT_PER_MM, width: l.length * PT_PER_MM, height: media.width * PT_PER_MM });
    page.drawRectangle({ x: x * PT_PER_MM, y: by * PT_PER_MM, width: l.length * PT_PER_MM, height: media.width * PT_PER_MM, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.4, borderDashArray: [2, 2] });
    const r = recs[i];
    const caption = `${r.id || "(no number)"}${r.end === "both" ? "" : ` · end ${r.end.toUpperCase()}`} · sh ${r.sheet}`.replace(/[^\x20-\x7e]/g, "-");
    page.drawText(caption, { x: x * PT_PER_MM, y: (by - 2.6) * PT_PER_MM, size: 5.5, font, color: rgb(0.35, 0.35, 0.35), maxWidth: Math.max(l.length, 20) * PT_PER_MM });
    x += Math.max(l.length, 22) + gapX;
  }
  return pdf.save();
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** database for P-touch Editor (File → Database → Connect): one row per label */
export function labelsCsv(recs: LabelRecord[], content: LabelContent): string {
  const head = ["Wire", "Detail", "End", "This end", "Other end", "Color", "Section", "Cable", "Sheet"];
  const rows = recs.map((r) => [r.id, detailLine(r, content), r.end === "both" ? "" : r.end.toUpperCase(), r.here, r.there, r.color, r.section, r.cable, r.sheet]);
  return "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
