/**
 * Logo uploads for title blocks: PNG, JPEG or SVG, checked and shrunk in the browser so a
 * logo stays small inside the project document.
 */
import type { TitleBlockLogo } from "@/core/model";
import { bytesToBase64, textToBase64 } from "@/core/logos";

/** largest file accepted for upload */
export const LOGO_MAX_INPUT = 2 * 1024 * 1024;
/** largest logo kept in the document (after shrinking) */
export const LOGO_MAX_STORED = 200 * 1024;
/** longest side of a stored raster logo, px (plenty for a title block cell at print resolution) */
export const LOGO_MAX_PX = 600;

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("The image could not be read"));
    img.src = src;
  });
}

const blobOf = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));

function hasAlpha(c: HTMLCanvasElement) {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/** Removes scripts and event handlers; the logo is only ever shown as an image, this keeps the stored file clean. */
export function cleanSvg(text: string): string {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("This is not a valid SVG file");
  for (const s of Array.from(doc.querySelectorAll("script, foreignObject"))) s.remove();
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || (/href$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

/** limits for pictures placed on pages (larger than logos: photos, product views) */
export const PICTURE_LIMITS = { maxPx: 1600, maxStored: 600 * 1024 };

export async function readLogoFile(file: File, limits: { maxPx: number; maxStored: number } = { maxPx: LOGO_MAX_PX, maxStored: LOGO_MAX_STORED }): Promise<{ name: string; logo: TitleBlockLogo; note?: string }> {
  const LOGO_MAX_PX = limits.maxPx, LOGO_MAX_STORED = limits.maxStored;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = file.type === "image/svg+xml" || ext === "svg" ? "svg" : file.type === "image/png" || ext === "png" ? "png" : file.type === "image/jpeg" || ext === "jpg" || ext === "jpeg" ? "jpg" : null;
  if (!type) throw new Error("Use a PNG, JPEG or SVG image");
  if (file.size > LOGO_MAX_INPUT) throw new Error(`The file is ${kb(file.size)}; logos must be under ${kb(LOGO_MAX_INPUT)}`);
  const base = file.name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "logo";
  if (type === "svg") {
    const svg = cleanSvg(await file.text());
    if (svg.length > LOGO_MAX_STORED) throw new Error(`This SVG is ${kb(svg.length)}; SVG logos must be under ${kb(LOGO_MAX_STORED)}. Simplify it or export a PNG`);
    return { name: `${base}.svg`, logo: { type: "svg", data: textToBase64(svg) } };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) throw new Error("The image could not be read");
    if (file.size <= LOGO_MAX_STORED && Math.max(nw, nh) <= LOGO_MAX_PX) {
      return { name: `${base}.${type}`, logo: { type, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) } };
    }
    let scale = Math.min(1, LOGO_MAX_PX / Math.max(nw, nh));
    for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(nw * scale));
      c.height = Math.max(1, Math.round(nh * scale));
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const png = type === "png" && hasAlpha(c);
      const blob = png ? await blobOf(c, "image/png") : await blobOf(c, "image/jpeg", 0.9);
      if (!blob) break;
      if (blob.size <= LOGO_MAX_STORED) {
        const t = png ? "png" : "jpg";
        return { name: `${base}.${t}`, logo: { type: t, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) }, note: `resized to ${c.width}×${c.height} px, ${kb(blob.size)}` };
      }
    }
    throw new Error(`This image is too detailed to fit in ${kb(LOGO_MAX_STORED)}; try a simpler logo`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Browser SVG → PNG bytes, for PDF export. */
export async function rasterizeSvg(svg: string, w: number, h: number): Promise<Uint8Array | null> {
  try {
    const img = await loadImage(`data:image/svg+xml;base64,${textToBase64(svg)}`);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const blob = await blobOf(c, "image/png");
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
