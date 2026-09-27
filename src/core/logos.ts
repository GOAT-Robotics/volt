/**
 * Title block logos: base64 image data (PNG, JPEG or SVG) with natural size detection, so a
 * logo can be fitted into its cell the same way on screen, in SVG and in PDF.
 */
import type { TitleBlockLogo } from "./model";

export const LOGO_MIME: Record<TitleBlockLogo["type"], string> = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" };

/** QET writes "png", "jpg", "JPG", "jpeg", "svg". */
export function logoType(t: string): TitleBlockLogo["type"] | null {
  const s = t.toLowerCase();
  return s === "png" ? "png" : s === "jpg" || s === "jpeg" ? "jpg" : s === "svg" ? "svg" : null;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const textToBase64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
export const base64ToText = (b64: string) => new TextDecoder().decode(base64ToBytes(b64));

export const logoDataUrl = (l: TitleBlockLogo) => `data:${LOGO_MIME[l.type]};base64,${l.data}`;

/** Decoded size of a logo in bytes. */
export const logoBytes = (l: TitleBlockLogo) => Math.floor((l.data.replace(/\s+/g, "").length * 3) / 4);

function pngSize(b: Uint8Array) {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

function jpgSize(b: Uint8Array) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
      i += m === 0xff ? 1 : 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}

function svgLength(s: string | undefined) {
  if (!s) return NaN;
  const m = /^\s*([0-9.]+)\s*(px|pt|mm|cm|in)?\s*$/.exec(s);
  if (!m) return NaN;
  const k = { px: 1, pt: 4 / 3, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[m[2] ?? "px"] ?? 1;
  return parseFloat(m[1]) * k;
}

export function svgSize(text: string) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
  const a = (n: string) => new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const vb = a("viewBox")?.trim().split(/[\s,]+/).map(Number);
  let w = svgLength(a("width")), h = svgLength(a("height"));
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (!(w > 0) && !(h > 0)) [w, h] = [vb[2], vb[3]];
    else if (!(w > 0)) w = (h * vb[2]) / vb[3];
    else if (!(h > 0)) h = (w * vb[3]) / vb[2];
  }
  return w > 0 && h > 0 ? { w, h } : { w: 100, h: 100 };
}

const sizes = new Map<string, { w: number; h: number } | null>();

/** Natural size (px) of a logo image, or null when the data is unreadable. */
export function logoSize(l: TitleBlockLogo): { w: number; h: number } | null {
  const key = l.type + ":" + l.data.length + ":" + l.data.slice(0, 64) + l.data.slice(-64);
  if (sizes.has(key)) return sizes.get(key)!;
  let r: { w: number; h: number } | null = null;
  try {
    if (l.type === "svg") r = svgSize(base64ToText(l.data));
    else {
      const b = base64ToBytes(l.type === "png" ? l.data.slice(0, 64) : l.data);
      r = l.type === "png" ? pngSize(b) : jpgSize(b);
    }
  } catch {
    r = null;
  }
  if (r && (!(r.w > 0) || !(r.h > 0))) r = null;
  if (sizes.size > 200) sizes.clear();
  sizes.set(key, r);
  return r;
}

/** "contain" fit of a w×h image in a box, centered, with padding. */
export function fitContain(img: { w: number; h: number }, box: { x: number; y: number; w: number; h: number }, pad = 2) {
  const bw = Math.max(0, box.w - pad * 2), bh = Math.max(0, box.h - pad * 2);
  const s = Math.min(bw / img.w, bh / img.h);
  const w = img.w * s, h = img.h * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Stable short key for caching decoded images. */
export function logoKey(l: TitleBlockLogo): string {
  let h = 2166136261;
  const d = l.data;
  const step = Math.max(1, Math.floor(d.length / 4096));
  for (let i = 0; i < d.length; i += step) h = Math.imul(h ^ d.charCodeAt(i), 16777619);
  return `${l.type}:${d.length}:${(h >>> 0).toString(36)}`;
}
