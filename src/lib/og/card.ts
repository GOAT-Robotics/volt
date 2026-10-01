/**
 * Link preview cards (Open Graph / Twitter, 1200 × 630) as SVG. Pure: rasterized by ./raster.
 *
 * Layout follows the app: white paper, black line work, one accent. With a picture, the sheet (or
 * symbol) sits on the left like a print on a desk and the text runs down the right column; without
 * one, the title is set large over faint schematic line art.
 */
import { approxMeasure } from "@/core/render/svg";
import { schematicArt } from "@/lib/brand/schematic";

export const OG_W = 1200;
export const OG_H = 630;

export type Card = {
  /** small caps line above the title, e.g. "PROJECT · EX-EL-CP-SC-001" */
  kicker: string;
  title: string;
  /** detail lines under the title (revision, sheets, status …) */
  lines?: string[];
  /** a standalone SVG document (title page, symbol) shown on the left */
  picture?: string | null;
  /** white "sheet" frame around the picture (drawings) or plain (symbols) */
  frame?: boolean;
  /** organization logo as a data URI, bottom right */
  brandLogo?: string | null;
  seed?: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n: number) => String(Math.round(n * 10) / 10);
const HEAD = "Work Sans";
/** Work Sans runs a little wider than the Arial-like estimate */
const measure = (t: string, size: number, bold = false) => approxMeasure(t, size, HEAD, bold ? 700 : 400) * 1.08;

/** greedy word wrap; the last line gets an ellipsis when the text does not fit */
export function wrap(text: string, size: number, width: number, maxLines: number, bold = true): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    // a single word wider than the column is cut
    while (measure(w, size, bold) > width && w.length > 1) {
      if (cur) (out.push(cur), (cur = ""));
      let k = w.length - 1;
      while (k > 1 && measure(w.slice(0, k) + "-", size, bold) > width) k--;
      out.push(w.slice(0, k) + "-");
      w = w.slice(k);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next, size, bold) <= width) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && measure(last + "…", size, bold) > width) last = last.slice(0, -1).trimEnd();
    kept[maxLines - 1] = last + "…";
    return kept;
  }
  return out;
}

/** a standalone SVG document → nested <svg> fitted into the box (text stays text) */
export function nestSvg(doc: string, x: number, y: number, w: number, h: number): string {
  const body = doc.replace(/<\?xml[^>]*\?>/, "").replace(/<title>[\s\S]*?<\/title>/, "");
  const m = /<svg\b([^>]*)>/.exec(body);
  if (!m) return "";
  const vb = /viewBox="([^"]+)"/.exec(m[1])?.[1] ?? `0 0 ${w} ${h}`;
  const inner = body.slice(m.index + m[0].length).replace(/<\/svg>\s*$/, "");
  return `<svg x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${inner}</svg>`;
}

/** aspect ratio (w / h) of a standalone SVG */
export function svgAspect(doc: string): number {
  const vb = /viewBox="([-\d.e]+)[ ,]+([-\d.e]+)[ ,]+([-\d.e]+)[ ,]+([-\d.e]+)"/.exec(doc);
  if (!vb) return 1.414;
  const w = Number(vb[3]), h = Number(vb[4]);
  return w > 0 && h > 0 ? w / h : 1.414;
}

const VOLT_MARK = (x: number, y: number, s: number) =>
  `<g transform="translate(${f(x)} ${f(y)}) scale(${f(s / 64)})"><rect width="64" height="64" rx="15" fill="#2546eb"/><path d="M15.5 15.5 L30.5 47.5 L39 31 H31.5 L48.5 15.5" fill="none" stroke="#fff" stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round"/></g>`;

export function cardSvg(c: Card): string {
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${OG_W} ${OG_H}" width="${OG_W}" height="${OG_H}">`);
  out.push(
    `<defs><pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#d4d4d8"/></pattern>` +
      `<filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feGaussianBlur stdDeviation="10"/></filter></defs>`,
  );
  out.push(`<rect width="${OG_W}" height="${OG_H}" fill="#fafafa"/><rect width="${OG_W}" height="${OG_H}" fill="url(#dots)"/>`);

  const pic = c.picture ?? null;
  const textX = pic ? 740 : 88;
  const textW = pic ? OG_W - textX - 64 : OG_W - 2 * 88;

  if (pic) {
    // picture box on the left, sized to the drawing's own proportions
    const boxX = 56, boxY = 56, maxW = 640, maxH = OG_H - 2 * boxY;
    const a = svgAspect(pic);
    let w = maxW, h = w / a;
    if (h > maxH) (h = maxH), (w = h * a);
    const x = boxX + (maxW - w) / 2, y = boxY + (maxH - h) / 2;
    if (c.frame !== false) {
      out.push(`<rect x="${f(x + 4)}" y="${f(y + 10)}" width="${f(w)}" height="${f(h)}" fill="#000" opacity="0.14" filter="url(#sh)"/>`);
      out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="#fff" stroke="#d4d4d8" stroke-width="1"/>`);
      out.push(nestSvg(pic, x + 6, y + 6, w - 12, h - 12));
    } else {
      out.push(`<rect x="${f(boxX)}" y="${f(boxY)}" width="${f(maxW)}" height="${f(maxH)}" rx="18" fill="#fff" stroke="#e4e4e7"/>`);
      // symbols are small: enlarge at most 3× so line weights stay like a printed sheet
      const vb = /viewBox="[-\d.e]+[ ,]+[-\d.e]+[ ,]+([-\d.e]+)[ ,]+([-\d.e]+)"/.exec(pic);
      const bw = maxW - 120, bh = maxH - 100;
      const k = vb ? Math.min(bw / Number(vb[1]), bh / Number(vb[2]), 3) : 1;
      const w = vb ? Number(vb[1]) * k : bw, h = vb ? Number(vb[2]) * k : bh;
      out.push(nestSvg(pic, boxX + 60 + (bw - w) / 2, boxY + 50 + (bh - h) / 2, w, h));
    }
  } else {
    // faint schematic line art behind the text, fading to the left
    out.push(
      `<defs><linearGradient id="fade" x1="0" x2="1"><stop offset="0.25" stop-color="#fafafa" stop-opacity="1"/><stop offset="0.75" stop-color="#fafafa" stop-opacity="0"/></linearGradient></defs>`,
    );
    out.push(`<g color="#18181b" opacity="0.28">${schematicArt({ width: OG_W, height: OG_H, seed: c.seed ?? 3, stroke: 1.3 })}</g>`);
    out.push(`<rect width="${OG_W}" height="${OG_H}" fill="url(#fade)"/>`);
  }

  // text column; the big (no picture) layout is centred in the space above the footer
  const big = !pic;
  let titleSize = big ? 68 : 44;
  let title = wrap(c.title || "Untitled", titleSize, textW, big ? 3 : 4);
  if (big && title.length > 2) (titleSize = 56), (title = wrap(c.title || "Untitled", titleSize, textW, 3));
  const lh = Math.round(titleSize * 1.14);
  const details = (c.lines ?? []).slice(0, big ? (title.length > 2 ? 2 : 3) : 5);
  const blockH = 22 + titleSize + (title.length - 1) * lh + 8 + 34 + details.length * 34;
  let y = big ? Math.max(70, (OG_H - 120 - blockH) / 2 + 17) : 118;
  out.push(`<text x="${textX}" y="${f(y)}" font-family="${HEAD}" font-weight="700" font-size="17" letter-spacing="2.5" fill="#71717a">${esc(c.kicker.toUpperCase())}</text>`);
  y += 22 + titleSize;
  for (const t of title) {
    out.push(`<text x="${textX}" y="${f(y)}" font-family="${HEAD}" font-weight="700" font-size="${titleSize}" letter-spacing="-0.5" fill="#09090b">${esc(t)}</text>`);
    y += lh;
  }
  y += 8 - lh + titleSize * 0.45;
  out.push(`<rect x="${textX}" y="${f(y)}" width="56" height="4" fill="#2546eb"/>`);
  y += 44;
  for (const l of details) {
    const t = wrap(l, 22, textW, 1, false)[0] ?? "";
    out.push(`<text x="${textX}" y="${f(y)}" font-family="${HEAD}" font-size="22" fill="#3f3f46">${esc(t)}</text>`);
    y += 34;
  }

  // footer: Volt on the left of the text column, the organization logo on the right
  const fy = OG_H - 56;
  out.push(VOLT_MARK(textX, fy - 34, 40));
  out.push(`<text x="${textX + 52}" y="${fy - 5}" font-family="${HEAD}" font-weight="700" font-size="28" letter-spacing="-0.5" fill="#09090b">Volt</text>`);
  if (c.brandLogo) out.push(`<rect x="${OG_W - 64 - 148}" y="${fy - 66}" width="164" height="86" rx="8" fill="#fafafa"/>`, `<image x="${OG_W - 64 - 132}" y="${fy - 58}" width="132" height="69" href="${c.brandLogo}"/>`);
  out.push("</svg>");
  return out.join("");
}
