"use client";
import type { ElementDef } from "@/core/model";
import { CanvasPainter } from "@/core/render/canvas";
import { drawElement } from "@/core/render/scene";
import { defaultStyles } from "@/core/styles";

const styles = defaultStyles();
const urlCache = new WeakMap<ElementDef, string>();

/** Rasterise a symbol preview (cached data URL). */
export function symbolThumb(def: ElementDef, size = 56): string {
  const c = urlCache.get(def);
  if (c) return c;
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * dpr;
  const ctx = canvas.getContext("2d")!;
  const bw = Math.max(def.width, 10), bh = Math.max(def.height, 10);
  const s = Math.min((size - 8) / bw, (size - 8) / bh, 3);
  const cx = size / 2, cy = size / 2;
  const ox = cx - (-def.hotspotX + bw / 2) * s, oy = cy - (-def.hotspotY + bh / 2) * s;
  const p = new CanvasPainter(ctx, [s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr], dpr);
  drawElement(p, { id: "t", defId: def.id, x: 0, y: 0, rot: 0, mirror: false, info: {}, texts: [] }, def, styles, { lod: s * 2, measure: p.measure.bind(p), pins: false });
  const url = canvas.toDataURL();
  urlCache.set(def, url);
  return url;
}
