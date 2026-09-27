/** Bill-of-materials pages for the PDF export (A4 landscape tables, repeated header, page x / y). */
import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { rgb } from "pdf-lib";
import { BOM_COLUMNS, CABLE_COLUMNS, bomCell, type Bom } from "../bom";

type Fonts = { regular: PDFFont; bold: PDFFont };

/** Helvetica (WinAnsi) can't draw every character: map the common ones, replace the rest. */
export function winAnsi(s: string): string {
  return s
    .replace(/Ω/g, "Ohm")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[^\x20-\x7e\xa0-\xff€•…]/g, "?");
}

const W = 841.89, H = 595.28, M = 32, SIZE = 8, LINE = 10.5;

function fit(font: PDFFont, s: string, w: number): string[] {
  const text = winAnsi(s);
  if (font.widthOfTextAtSize(text, SIZE) <= w) return [text];
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/(?<=[ ,])/)) {
    const next = cur + word;
    if (font.widthOfTextAtSize(next, SIZE) <= w) cur = next;
    else {
      if (cur) out.push(cur.trimEnd());
      cur = word;
      while (font.widthOfTextAtSize(cur, SIZE) > w && cur.length > 1) {
        let k = cur.length - 1;
        while (k > 1 && font.widthOfTextAtSize(cur.slice(0, k), SIZE) > w) k--;
        out.push(cur.slice(0, k));
        cur = cur.slice(k);
      }
    }
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

function table(pdf: PDFDocument, fonts: Fonts, heading: string, sub: string, cols: { label: string; w: number; right?: boolean }[], rows: string[][], pages: PDFPage[]) {
  const total = cols.reduce((a, c) => a + c.w, 0);
  const scale = (W - 2 * M) / total;
  const widths = cols.map((c) => c.w * scale);
  let pg!: PDFPage;
  let y = 0;
  const header = () => {
    pg = pdf.addPage([W, H]);
    pages.push(pg);
    y = H - M;
    pg.drawText(winAnsi(heading), { x: M, y: y - 12, size: 14, font: fonts.bold });
    if (sub) pg.drawText(winAnsi(sub), { x: M, y: y - 26, size: 8.5, font: fonts.regular, color: rgb(0.35, 0.38, 0.45) });
    y -= 42;
    pg.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: LINE + 5, color: rgb(0.91, 0.93, 0.97) });
    let x = M;
    cols.forEach((c, i) => {
      pg.drawText(winAnsi(c.label), { x: x + 3, y: y, size: SIZE, font: fonts.bold });
      x += widths[i];
    });
    y -= LINE + 5;
  };
  header();
  rows.forEach((r, ri) => {
    const cells = r.map((v, i) => fit(fonts.regular, v, widths[i] - 6));
    const n = Math.max(1, ...cells.map((c) => c.length));
    if (y - n * LINE < M + 14) header();
    if (ri % 2 === 1) pg.drawRectangle({ x: M, y: y - (n - 1) * LINE - 3.5, width: W - 2 * M, height: n * LINE + 1, color: rgb(0.97, 0.975, 0.985) });
    let x = M;
    cells.forEach((lines, i) => {
      lines.forEach((l, k) => {
        const tx = cols[i].right ? x + widths[i] - 3 - fonts.regular.widthOfTextAtSize(l, SIZE) : x + 3;
        pg.drawText(l, { x: tx, y: y - k * LINE, size: SIZE, font: fonts.regular });
      });
      x += widths[i];
    });
    y -= n * LINE + 1;
  });
  if (!rows.length) pg.drawText("No parts on the selected pages.", { x: M + 3, y, size: SIZE, font: fonts.regular, color: rgb(0.4, 0.4, 0.4) });
}

/** Append the bill of materials (and the cable list) as A4 landscape pages. */
export function appendBomPages(pdf: PDFDocument, fonts: Fonts, bom: Bom, meta: { title: string; subtitle?: string }) {
  const pages: PDFPage[] = [];
  const widths: Record<string, number> = { item: 4, qty: 4.5, unit: 4, refs: 16, name: 17, rating: 11, manufacturer: 10, partNumber: 12, supplier: 9, location: 8, sheets: 6 };
  const right = new Set(["item", "qty"]);
  const sub = [meta.subtitle, `${bom.rows.length} lines · ${bom.components} components${bom.missingPart ? ` · ${bom.missingPart} without part number` : ""}`].filter(Boolean).join(" · ");
  table(
    pdf,
    fonts,
    `Bill of materials — ${meta.title}`,
    sub,
    BOM_COLUMNS.map((c) => ({ label: c.label, w: widths[c.key], right: right.has(c.key) })),
    bom.rows.map((r) => BOM_COLUMNS.map((c) => String(bomCell(r, c.key)))),
    pages,
  );
  if (bom.cables.length) {
    const cw: Record<string, number> = { tag: 8, type: 24, cores: 5, section: 8, shield: 6, length: 7, note: 20 };
    table(
      pdf,
      fonts,
      `Cables — ${meta.title}`,
      meta.subtitle ?? "",
      CABLE_COLUMNS.map((c) => ({ label: c.label, w: cw[c.key], right: c.key === "cores" })),
      bom.cables.map((c) => CABLE_COLUMNS.map((k) => (k.key === "shield" ? (c.shield ? "yes" : "no") : String(c[k.key])))),
      pages,
    );
  }
  pages.forEach((pg, i) => {
    const t = `Page ${i + 1} / ${pages.length}`;
    pg.drawText(t, { x: W - M - fonts.regular.widthOfTextAtSize(t, 7.5), y: M - 14, size: 7.5, font: fonts.regular, color: rgb(0.45, 0.45, 0.5) });
  });
}
