"use client";
import { PIN_GRID } from "./actions";
import { useCallback, useEffect, useRef } from "react";
import type { ElemInst, Orient, PinDef, Prim, Pt, Rect } from "@/core/model";
import { CanvasPainter, measureText } from "@/core/render/canvas";
import { drawElement } from "@/core/render/scene";
import { defaultStyles } from "@/core/styles";
import type { Mat } from "@/core/geometry";
import type { PathData, StrokeStyle, TextDraw } from "@/core/render/painter";
import { INFO_KEYS, newUuid, pinBounds, symbolBounds, unionR, visualBounds } from "@/lib/library/elmt-tools";
import { useEd, defOf, withId, type EdPrim } from "./store";
import { applyHandle, autoOrient, boundsOfPrim, ellipsePoint, handlesOf, hitPin, hitPrim, nearestOnPrims, nextPinNumber, outVec, qetAngle, r1, selectionBounds, snapPoints, stubVec, translatePrim, type Handle, type OSnap, type OSnapKind } from "./geom";

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

type Theme = { dark: boolean; bg: string; grid: string; gridMajor: string; accent: string; frame: string; origin: string; ink: string };
function readTheme(): Theme {
  const dark = document.documentElement.classList.contains("dark");
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue("--accent").trim() || "#2563eb";
  return dark
    ? { dark, bg: "#141417", grid: "rgba(255,255,255,0.05)", gridMajor: "rgba(255,255,255,0.11)", accent, frame: "rgba(255,255,255,0.28)", origin: "#f87171", ink: "#e8e8ec" }
    : { dark, bg: "#fcfcfd", grid: "rgba(0,0,0,0.05)", gridMajor: "rgba(0,0,0,0.11)", accent, frame: "rgba(0,0,0,0.3)", origin: "#dc2626", ink: "#000000" };
}

/** Maps near-black symbol ink to a light colour on dark canvases. */
class ThemedPainter extends CanvasPainter {
  constructor(ctx: CanvasRenderingContext2D, base: Mat, dpr: number, private dark: boolean) {
    super(ctx, base, dpr);
  }
  private map(c: string) {
    if (!this.dark) return c;
    const l = c.toLowerCase();
    if (l === "#000000" || l === "#000" || l === "black" || l === "#111827" || l === "#18181b") return "#e8e8ec";
    if (l === "#374151" || l === "#6b7280") return "#b4b4bc";
    if (l === "#ffffff" || l === "white") return "#141417";
    return c;
  }
  stroke(p: PathData, s: StrokeStyle) {
    super.stroke(p, { ...s, color: this.map(s.color) });
  }
  fill(p: PathData, color: string, alpha?: number) {
    super.fill(p, this.map(color), alpha);
  }
  text(t: TextDraw) {
    super.text({ ...t, color: this.map(t.color) });
  }
}

const STYLES = (() => {
  const s = defaultStyles();
  s.text.pinNumber.visible = false;
  s.text.pinName.visible = false;
  return s;
})();

const PLACEHOLDER_INFO: Record<string, string> = Object.fromEntries(INFO_KEYS.map((k) => [k.id, k.id === "label" ? "K1" : `{${k.id}}`]));

/* ------------------------------------------------------------------ */
/* Interaction state                                                   */
/* ------------------------------------------------------------------ */

type Gesture =
  | { k: "none" }
  | { k: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { k: "move"; start: Pt; moved: boolean; dup: boolean; base?: Map<string, Prim | PinDef> }
  | { k: "box"; start: Pt; cur: Pt; add: boolean }
  | { k: "handle"; id: string; key: string; orig: Prim }
  | { k: "draw2"; tool: "line" | "rect" | "ellipse"; start: Pt; cur: Pt; dragged: boolean; sx: number; sy: number }
  | { k: "arc"; step: 1 | 2; center: Pt; start?: Pt; cur: Pt }
  | { k: "poly"; pts: Pt[]; cur: Pt };

export type CanvasApi = { fit(): void; zoom(f: number): void; reset(): void; perf(): number[] };

export function SymbolCanvas({ apiRef, readOnly }: { apiRef?: React.MutableRefObject<CanvasApi | null>; readOnly?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cvs = useRef<HTMLCanvasElement>(null);
  const view = useRef({ s: 4, ox: 300, oy: 250, w: 600, h: 500, dpr: 1 });
  const g = useRef<Gesture>({ k: "none" });
  const theme = useRef<Theme | null>(null);
  const raf = useRef(0);
  const space = useRef(false);
  const mouse = useRef<Pt | null>(null);
  const shiftKey = useRef(false);
  const altKey = useRef(false);
  const perf = useRef<number[]>([]);

  const toScene = (sx: number, sy: number): Pt => {
    const v = view.current;
    return { x: (sx - v.ox) / v.s, y: (sy - v.oy) / v.s };
  };
  const snap = useCallback((p: Pt, force = false): Pt => {
    const st = useEd.getState();
    if (!st.snap && !force) return { x: r1(p.x), y: r1(p.y) };
    const gs = st.grid;
    return { x: r1(Math.round(p.x / gs) * gs), y: r1(Math.round(p.y / gs) * gs) };
  }, []);
  /** last object-snap result under the cursor (drawn as an indicator) */
  const hint = useRef<OSnap | null>(null);
  /**
   * Smart snapping: pins, line ends and corners, centres and midpoints of the drawing win over the
   * grid anywhere on the canvas; `on` also snaps onto the nearest point of a line (pin placement).
   */
  const smart = useCallback(
    (p: Pt, o: { alt?: boolean; exclude?: string; on?: boolean; forceGrid?: boolean } = {}): OSnap => {
      if (o.alt) return { p: { x: r1(p.x), y: r1(p.y) }, kind: "free" };
      const st = useEd.getState();
      const radius = 9 / view.current.s;
      const weight: Record<OSnapKind, number> = { pin: 0.6, end: 0.75, center: 0.95, quadrant: 1, mid: 1.05, on: 1.4, grid: 9, free: 9 };
      let best: { s: OSnap; score: number } | null = null;
      for (const c of snapPoints(st.doc.prims, st.doc.pins, o.exclude)) {
        const d = Math.hypot(c.p.x - p.x, c.p.y - p.y);
        if (d > radius) continue;
        const score = d * weight[c.kind] + weight[c.kind] * 0.01;
        if (!best || score < best.score) best = { s: { p: { x: r1(c.p.x), y: r1(c.p.y) }, kind: c.kind }, score };
      }
      if (best) return best.s;
      if (o.on) {
        const n = nearestOnPrims(st.doc.prims, p, o.exclude);
        if (n && n.d <= radius * 0.7) {
          // keep the grid coordinate along the line when it lies on the grid line
          const g = snap(p, true);
          const q = Math.abs(n.p.x - g.x) < 1e-6 ? { x: g.x, y: g.y } : Math.abs(n.p.y - g.y) < 1e-6 ? { x: g.x, y: g.y } : n.p;
          return { p: { x: r1(q.x), y: r1(q.y) }, kind: "on" };
        }
      }
      return { p: snap(p, !!o.forceGrid), kind: st.snap || o.forceGrid ? "grid" : "free" };
    },
    [snap],
  );
  /**
   * Pins snap to the drawing grid (10) only — never to box centres or midpoints — because a
   * placed component's origin lands on the drawing grid and every pin must too, or wires jog.
   * Alt places freely.
   */
  const pinSnap = useCallback((p: Pt, alt?: boolean): OSnap => {
    if (alt) return { p: { x: r1(p.x), y: r1(p.y) }, kind: "free" };
    return { p: { x: Math.round(p.x / PIN_GRID) * PIN_GRID, y: Math.round(p.y / PIN_GRID) * PIN_GRID }, kind: "grid" };
  }, []);

  /* ---------------------------- drawing ---------------------------- */
  const draw = useCallback(() => {
    raf.current = 0;
    const c = cvs.current;
    if (!c) return;
    const t0 = performance.now();
    const ctx = c.getContext("2d", { alpha: false });
    if (!ctx) return;
    const v = view.current;
    const th = (theme.current ??= readTheme());
    const st = useEd.getState();
    const doc = st.doc;
    const dpr = v.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, v.w, v.h);

    // grid
    if (st.showGrid) {
      const x0 = -v.ox / v.s, y0 = -v.oy / v.s, x1 = (v.w - v.ox) / v.s, y1 = (v.h - v.oy) / v.s;
      const lines = (step: number, color: string) => {
        if (step * v.s < 7) return;
        ctx.beginPath();
        for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
          const sx = Math.round(x * v.s + v.ox) + 0.5;
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, v.h);
        }
        for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
          const sy = Math.round(y * v.s + v.oy) + 0.5;
          ctx.moveTo(0, sy);
          ctx.lineTo(v.w, sy);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      };
      lines(st.grid, th.grid);
      lines(st.grid * 10 >= 10 && st.grid < 10 ? 10 : 50, th.gridMajor);
    }

    const def = defOf(doc);
    const frame = { width: def.width, height: def.height, hotspotX: def.hotspotX, hotspotY: def.hotspotY };
    // QET element frame (width/height/hotspot as saved)
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = th.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(-frame.hotspotX * v.s + v.ox) + 0.5, Math.round(-frame.hotspotY * v.s + v.oy) + 0.5, Math.round(frame.width * v.s), Math.round(frame.height * v.s));
    ctx.restore();

    // symbol
    const inst: ElemInst = { id: "ed", defId: def.id, x: 0, y: 0, rot: 0, mirror: false, info: { ...PLACEHOLDER_INFO, ...def.info, label: "K1" }, texts: [], showPinNumbers: false, showPinNames: false };
    const painter = new ThemedPainter(ctx, [v.s * dpr, 0, 0, v.s * dpr, v.ox * dpr, v.oy * dpr], dpr, th.dark);
    drawElement(painter, inst, def, STYLES, { lod: v.s, pins: true, measure: measureText });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const S = (p: Pt) => ({ x: p.x * v.s + v.ox, y: p.y * v.s + v.oy });
    // pin labels (screen-constant size so they stay readable at any zoom)
    if (v.s > 1.2) {
      ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const counts = new Map<string, number>();
      for (const p of doc.pins) if (p.number.trim()) counts.set(p.number.trim(), (counts.get(p.number.trim()) ?? 0) + 1);
      for (const p of doc.pins) {
        const txt = p.number || p.name;
        if (!txt) continue;
        const a = S(p);
        const dup = (counts.get(p.number.trim()) ?? 0) > 1;
        const w = ctx.measureText(txt).width;
        let x: number, y: number;
        if (p.orient === "n" || p.orient === "s") (x = a.x + 7), (y = a.y + (p.orient === "n" ? -2 : 2));
        else (x = p.orient === "w" ? a.x - w - 7 : a.x + 7), (y = a.y - 9);
        ctx.fillStyle = th.bg;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x - 2, y - 7, w + 4, 14);
        ctx.globalAlpha = 1;
        ctx.fillStyle = dup ? "#dc2626" : th.dark ? "#fca5a5" : "#b91c1c";
        ctx.textAlign = "left";
        ctx.fillText(txt, x, y);
      }
    }
    // dynamic text frames (so empty info texts stay visible)
    ctx.save();
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = th.dark ? "rgba(147,197,253,0.45)" : "rgba(37,99,235,0.35)";
    for (const p of doc.prims) {
      if (p.t !== "dyntext") continue;
      const b = boundsOfPrim(p);
      if (b) ctx.strokeRect(b.x * v.s + v.ox, b.y * v.s + v.oy, b.w * v.s, b.h * v.s);
    }
    ctx.restore();

    // origin crosshair (hotspot)
    const o = S({ x: 0, y: 0 });
    ctx.strokeStyle = th.origin;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.x - 9, o.y);
    ctx.lineTo(o.x + 9, o.y);
    ctx.moveTo(o.x, o.y - 9);
    ctx.lineTo(o.x, o.y + 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(o.x, o.y, 3.5, 0, Math.PI * 2);
    ctx.stroke();

    // hover + selection outlines
    const sel = new Set(st.sel);
    const outline = (p: EdPrim, color: string, w: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      switch (p.t) {
        case "line": {
          const a = S({ x: p.x1, y: p.y1 }), b = S({ x: p.x2, y: p.y2 });
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          break;
        }
        case "rect":
          ctx.rect(p.x * v.s + v.ox, p.y * v.s + v.oy, p.w * v.s, p.h * v.s);
          break;
        case "ellipse":
          ctx.ellipse((p.x + p.w / 2) * v.s + v.ox, (p.y + p.h / 2) * v.s + v.oy, Math.abs((p.w / 2) * v.s), Math.abs((p.h / 2) * v.s), 0, 0, Math.PI * 2);
          break;
        case "arc": {
          const a0 = (-p.start * Math.PI) / 180, a1 = (-(p.start + p.angle) * Math.PI) / 180;
          const cx = (p.x + p.w / 2) * v.s + v.ox, cy = (p.y + p.h / 2) * v.s + v.oy;
          ctx.ellipse(cx, cy, Math.abs((p.w / 2) * v.s), Math.abs((p.h / 2) * v.s), 0, a0, a1, p.angle > 0);
          break;
        }
        case "polygon":
          p.pts.forEach((q, i) => {
            const s = S(q);
            if (i) ctx.lineTo(s.x, s.y);
            else ctx.moveTo(s.x, s.y);
          });
          if (p.closed) ctx.closePath();
          break;
        default: {
          const b = boundsOfPrim(p);
          if (b) ctx.rect(b.x * v.s + v.ox - 1, b.y * v.s + v.oy - 1, b.w * v.s + 2, b.h * v.s + 2);
        }
      }
      ctx.stroke();
    };
    const pinOutline = (p: PinDef, color: string) => {
      const a = S(p), vv = stubVec(p.orient);
      const b = S({ x: p.x + vv.x * 4, y: p.y + vv.y * 4 });
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (st.hover && !sel.has(st.hover)) {
      const hp = doc.prims.find((p) => p.id === st.hover);
      ctx.globalAlpha = 0.5;
      if (hp) outline(hp, th.accent, 3);
      ctx.globalAlpha = 1;
      const hpin = doc.pins.find((p) => p.id === st.hover);
      if (hpin) pinOutline(hpin, th.accent);
    }
    for (const p of doc.prims) if (sel.has(p.id)) outline(p, th.accent, 1.5);
    for (const p of doc.pins) if (sel.has(p.id)) pinOutline(p, th.accent);
    if (sel.size > 1) {
      const b = selectionBounds(doc.prims, doc.pins, sel);
      if (b) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x * v.s + v.ox - 3, b.y * v.s + v.oy - 3, b.w * v.s + 6, b.h * v.s + 6);
        ctx.restore();
      }
    }
    // handles
    if (st.tool === "select" && sel.size === 1 && !readOnly) {
      const p = doc.prims.find((x) => sel.has(x.id));
      if (p) {
        if (p.t === "arc") {
          const c = S({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
          ctx.save();
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = th.accent;
          ctx.lineWidth = 1;
          for (const k of [p.start, p.start + p.angle]) {
            const e = S(ellipsePoint(p, k));
            ctx.beginPath();
            ctx.moveTo(c.x, c.y);
            ctx.lineTo(e.x, e.y);
            ctx.stroke();
          }
          ctx.restore();
        }
        for (const h of handlesOf(p)) drawHandle(ctx, S(h), h, th);
      }
    }

    // gesture previews
    const ge = g.current;
    ctx.strokeStyle = th.accent;
    ctx.fillStyle = th.accent;
    ctx.lineWidth = 1.25;
    if (ge.k === "box") {
      const a = S(ge.start), b = S(ge.cur);
      const crossing = ge.cur.x < ge.start.x;
      ctx.save();
      ctx.globalAlpha = 0.08;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
      ctx.save();
      if (crossing) ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
    } else if (ge.k === "draw2") {
      const a = S(ge.start), b = S(ge.cur);
      ctx.beginPath();
      if (ge.tool === "line") {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      } else if (ge.tool === "rect") ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      sizeLabel(ctx, b, ge.tool === "line" ? `${r1(Math.hypot(ge.cur.x - ge.start.x, ge.cur.y - ge.start.y))}` : `${r1(Math.abs(ge.cur.x - ge.start.x))} × ${r1(Math.abs(ge.cur.y - ge.start.y))}`, th);
    } else if (ge.k === "arc") {
      const c = S(ge.center);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (ge.step === 1) {
        const r = Math.hypot(ge.cur.x - ge.center.x, ge.cur.y - ge.center.y) * v.s;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        const e = S(ge.cur);
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      } else if (ge.start) {
        const a = arcFrom(ge.center, ge.start, ge.cur);
        const a0 = (-a.start * Math.PI) / 180, a1 = (-(a.start + a.angle) * Math.PI) / 180;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, (a.w / 2) * v.s, (a.h / 2) * v.s, 0, a0, a1, a.angle > 0);
        ctx.stroke();
        sizeLabel(ctx, S(ge.cur), `${Math.round(Math.abs(a.angle))}°`, th);
      }
    } else if (ge.k === "poly") {
      ctx.beginPath();
      [...ge.pts, ge.cur].forEach((q, i) => {
        const s = S(q);
        if (i) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
      });
      if (st.toolOpts.polyClosed && ge.pts.length > 1) ctx.closePath();
      ctx.stroke();
      for (const q of ge.pts) {
        const s = S(q);
        ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
      }
    }
    // pin ghost
    if (st.tool === "pin" && mouse.current && ge.k === "none" && !readOnly) {
      const p = pinSnap(mouse.current, altKey.current).p;
      const orient = st.toolOpts.pinOrient ?? autoOrient(p, bodyBox(doc.prims));
      const a = S(p), vv = stubVec(orient);
      const b = S({ x: p.x + vv.x * 4, y: p.y + vv.y * 4 });
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      const ov = outVec(orient);
      ctx.beginPath();
      ctx.moveTo(a.x + ov.x * 12, a.y + ov.y * 12);
      ctx.lineTo(a.x + ov.x * 6 + ov.y * 3, a.y + ov.y * 6 + ov.x * 3);
      ctx.moveTo(a.x + ov.x * 12, a.y + ov.y * 12);
      ctx.lineTo(a.x + ov.x * 6 - ov.y * 3, a.y + ov.y * 6 - ov.x * 3);
      ctx.stroke();
      ctx.restore();
      sizeLabel(ctx, { x: a.x + 8, y: a.y + 16 }, `${nextPinNumber(doc.pins)} · ${orient.toUpperCase()}${st.toolOpts.pinOrient ? "" : " (auto)"}`, th);
    }
    // crosshair cursor for drawing tools
    // object-snap indicator
    const hs = hint.current;
    if (hs && hs.kind !== "grid" && hs.kind !== "free" && !readOnly && (st.tool !== "select" || ge.k === "handle")) {
      const q = S(hs.p);
      ctx.save();
      ctx.strokeStyle = "#16a34a";
      ctx.fillStyle = "#16a34a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (hs.kind === "end" || hs.kind === "pin") ctx.rect(q.x - 5, q.y - 5, 10, 10);
      else if (hs.kind === "mid") {
        ctx.moveTo(q.x, q.y - 6);
        ctx.lineTo(q.x + 6, q.y + 4);
        ctx.lineTo(q.x - 6, q.y + 4);
        ctx.closePath();
      } else if (hs.kind === "on") {
        ctx.moveTo(q.x - 5, q.y - 5);
        ctx.lineTo(q.x + 5, q.y + 5);
        ctx.moveTo(q.x + 5, q.y - 5);
        ctx.lineTo(q.x - 5, q.y + 5);
      } else ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const label = { pin: "Pin", end: "Endpoint", mid: "Midpoint", center: "Center", quadrant: "Quadrant", on: "On line", grid: "", free: "" }[hs.kind];
      const w = ctx.measureText(label).width + 8;
      ctx.globalAlpha = 0.92;
      ctx.fillRect(q.x + 9, q.y - 22, w, 15);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.fillText(label, q.x + 13, q.y - 14.5);
      ctx.restore();
    }
    if (st.tool !== "select" && mouse.current && !readOnly) {
      const p = S(hint.current?.p ?? snap(mouse.current));
      ctx.save();
      ctx.strokeStyle = th.accent;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x - 6, p.y);
      ctx.lineTo(p.x + 6, p.y);
      ctx.moveTo(p.x, p.y - 6);
      ctx.lineTo(p.x, p.y + 6);
      ctx.stroke();
      ctx.restore();
    }
    const dt = performance.now() - t0;
    const pf = perf.current;
    pf.push(dt);
    if (pf.length > 600) pf.splice(0, pf.length - 600);
  }, [readOnly, snap, smart]);

  const request = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  }, [draw]);

  /* ---------------------------- view ---------------------------- */
  const fit = useCallback(() => {
    const st = useEd.getState();
    const v = view.current;
    const b: Rect = unionR(visualBounds({ prims: st.doc.prims, pins: st.doc.pins }), { x: -20, y: -20, w: 40, h: 40 })!;
    const s = Math.min(40, Math.max(0.5, Math.min((v.w - 80) / b.w, (v.h - 80) / b.h)));
    v.s = s;
    v.ox = v.w / 2 - (b.x + b.w / 2) * s;
    v.oy = v.h / 2 - (b.y + b.h / 2) * s;
    useEd.getState().set({ zoomPct: Math.round(s * 100) });
    request();
  }, [request]);
  const zoomAt = useCallback(
    (f: number, sx?: number, sy?: number) => {
      const v = view.current;
      const cx = sx ?? v.w / 2, cy = sy ?? v.h / 2;
      const ns = Math.min(80, Math.max(0.4, v.s * f));
      const k = ns / v.s;
      v.ox = cx - (cx - v.ox) * k;
      v.oy = cy - (cy - v.oy) * k;
      v.s = ns;
      zoomLabel(ns);
      request();
    },
    [request],
  );
  const zoomT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomLabel = (s: number) => {
    if (zoomT.current) return;
    zoomT.current = setTimeout(() => {
      zoomT.current = null;
      useEd.getState().set({ zoomPct: Math.round(view.current.s * 100) });
    }, 120);
    void s;
  };

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      fit,
      zoom: (f) => zoomAt(f),
      reset: () => {
        const v = view.current;
        zoomAt(1 / v.s * 4);
      },
      perf: () => [...perf.current],
    };
  }, [apiRef, fit, zoomAt]);

  /* ---------------------------- setup ---------------------------- */
  useEffect(() => {
    const c = cvs.current!, w = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = w.getBoundingClientRect();
      const v = view.current;
      const first = v.w === 600 && v.h === 500;
      v.w = Math.max(50, r.width);
      v.h = Math.max(50, r.height);
      v.dpr = Math.min(3, window.devicePixelRatio || 1);
      c.width = Math.round(v.w * v.dpr);
      c.height = Math.round(v.h * v.dpr);
      c.style.width = `${v.w}px`;
      c.style.height = `${v.h}px`;
      if (first) fit();
      else draw();
    });
    ro.observe(w);
    const unsub = useEd.subscribe((s, p) => {
      if (s.doc !== p.doc || s.sel !== p.sel || s.hover !== p.hover || s.tool !== p.tool || s.grid !== p.grid || s.showGrid !== p.showGrid || s.toolOpts !== p.toolOpts) request();
      if (s.tick !== p.tick) fit();
      if (s.tool !== p.tool) g.current = { k: "none" };
    });
    const mo = new MutationObserver(() => {
      theme.current = null;
      request();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      ro.disconnect();
      unsub();
      mo.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [draw, fit, request]);

  /* ---------------------------- hit testing ---------------------------- */
  const hitAt = (p: Pt): string | null => {
    const st = useEd.getState();
    const tol = 5 / view.current.s;
    for (let i = st.doc.pins.length - 1; i >= 0; i--) if (hitPin(st.doc.pins[i], p, tol)) return st.doc.pins[i].id;
    // texts first (they sit on top), then shapes top-most first
    for (let i = st.doc.prims.length - 1; i >= 0; i--) {
      const q = st.doc.prims[i];
      if ((q.t === "text" || q.t === "dyntext") && hitPrim(q, p, tol)) return q.id;
    }
    for (let i = st.doc.prims.length - 1; i >= 0; i--) {
      const q = st.doc.prims[i];
      if (q.t !== "text" && q.t !== "dyntext" && hitPrim(q, p, tol + ("style" in q ? 0.5 : 0))) return q.id;
    }
    return null;
  };
  const handleAt = (sp: Pt): { id: string; h: Handle } | null => {
    const st = useEd.getState();
    if (st.sel.length !== 1) return null;
    const p = st.doc.prims.find((x) => x.id === st.sel[0]);
    if (!p) return null;
    const v = view.current;
    const hs = handlesOf(p);
    // angle handles take priority
    hs.sort((a, b) => (a.kind === "angle" ? -1 : 0) - (b.kind === "angle" ? -1 : 0));
    for (const h of hs) if (Math.abs(h.x * v.s + v.ox - sp.x) <= 6 && Math.abs(h.y * v.s + v.oy - sp.y) <= 6) return { id: p.id, h };
    return null;
  };

  /* ---------------------------- creation ---------------------------- */
  const create = (prim: Prim) => {
    const ep = withId(prim);
    useEd.getState().change((d) => {
      d.prims.push(ep as EdPrim);
    });
    useEd.getState().setSel([ep.id]);
    return ep;
  };
  const finishPoly = () => {
    const ge = g.current;
    if (ge.k !== "poly") return;
    g.current = { k: "none" };
    const pts = ge.pts.filter((q, i) => i === 0 || q.x !== ge.pts[i - 1].x || q.y !== ge.pts[i - 1].y);
    if (pts.length >= 2) {
      const closed = useEd.getState().toolOpts.polyClosed && pts.length > 2;
      if (pts.length === 2 && !closed) create({ t: "line", x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, end1: "none", end2: "none", len1: 1.5, len2: 1.5, style: sty() });
      else create({ t: "polygon", pts, closed, style: sty() });
    }
    request();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ge = g.current;
      shiftKey.current = e.shiftKey;
      if (e.type === "keyup") {
        if (e.code === "Space") space.current = false;
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.code === "Space") {
        space.current = true;
        if (wrap.current?.matches(":hover")) e.preventDefault();
      }
      if (ge.k === "poly") {
        if (e.key === "Enter") {
          e.preventDefault();
          finishPoly();
        } else if (e.key === "Escape") {
          g.current = { k: "none" };
          request();
        } else if (e.key === "Backspace") {
          e.preventDefault();
          ge.pts.pop();
          if (!ge.pts.length) g.current = { k: "none" };
          request();
        }
        e.stopImmediatePropagation();
        return;
      }
      if (e.key === "Escape" && ge.k !== "none") {
        if (ge.k === "move" || ge.k === "handle") useEd.getState().cancelGesture();
        g.current = { k: "none" };
        request();
        e.stopImmediatePropagation();
      }
      if (useEd.getState().tool === "pin" && (e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey) {
        const st = useEd.getState();
        const order: Orient[] = ["n", "e", "s", "w"];
        const cur = st.toolOpts.pinOrient ?? autoOrient(smart(mouse.current ?? { x: 0, y: 0 }, { on: true, forceGrid: true }).p, bodyBox(st.doc.prims));
        st.setToolOpts({ pinOrient: order[(order.indexOf(cur) + 1) % 4] });
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, snap, smart]);

  /* ---------------------------- pointer ---------------------------- */
  const local = (e: React.PointerEvent | React.MouseEvent | WheelEvent): Pt => {
    const r = cvs.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const sp = local(e);
    const p = toScene(sp.x, sp.y);
    const st = useEd.getState();
    wrap.current?.focus({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && space.current) || (readOnly && e.button === 0)) {
      g.current = { k: "pan", sx: sp.x, sy: sp.y, ox: view.current.ox, oy: view.current.oy };
      cvs.current!.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || readOnly) return;
    cvs.current!.setPointerCapture(e.pointerId);
    const sn = smart(p, { alt: e.altKey }).p;
    const ge = g.current;
    switch (st.tool) {
      case "select": {
        const h = handleAt(sp);
        if (h) {
          const orig = st.doc.prims.find((x) => x.id === h.id)!;
          st.begin();
          g.current = { k: "handle", id: h.id, key: h.h.key, orig: JSON.parse(JSON.stringify(orig)) };
          return;
        }
        const id = hitAt(p);
        if (id) {
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            st.setSel(st.sel.includes(id) ? st.sel.filter((x) => x !== id) : [...st.sel, id]);
            return;
          }
          if (!st.sel.includes(id)) st.setSel([id]);
          st.begin();
          g.current = { k: "move", start: p, moved: false, dup: e.altKey };
        } else {
          if (!e.shiftKey) st.setSel([]);
          g.current = { k: "box", start: p, cur: p, add: e.shiftKey };
        }
        return;
      }
      case "line":
      case "rect":
      case "ellipse": {
        if (ge.k === "draw2" && !ge.dragged) {
          // second click of click-click mode
          commit2(ge.tool, ge.start, constrain(ge.tool, ge.start, sn, e.shiftKey));
          g.current = { k: "none" };
          request();
          return;
        }
        g.current = { k: "draw2", tool: st.tool, start: sn, cur: sn, dragged: false, sx: sp.x, sy: sp.y };
        return;
      }
      case "arc": {
        if (ge.k !== "arc") g.current = { k: "arc", step: 1, center: sn, cur: sn };
        else if (ge.step === 1) {
          if (sn.x === ge.center.x && sn.y === ge.center.y) return;
          g.current = { k: "arc", step: 2, center: ge.center, start: sn, cur: sn };
        } else if (ge.start) {
          const a = arcFrom(ge.center, ge.start, e.shiftKey ? ge.cur : sn);
          if (Math.abs(a.angle) >= 1) create({ t: "arc", ...a, style: sty() });
          g.current = { k: "none" };
        }
        request();
        return;
      }
      case "polygon": {
        if (ge.k === "poly") {
          const last = ge.pts[ge.pts.length - 1];
          // click on first point closes
          const first = ge.pts[0];
          if (ge.pts.length > 2 && Math.hypot(first.x - sn.x, first.y - sn.y) * view.current.s < 6) {
            useEd.getState().setToolOpts({ polyClosed: true });
            finishPoly();
            return;
          }
          if (!last || last.x !== sn.x || last.y !== sn.y) ge.pts.push(e.shiftKey && last ? ortho(last, sn) : sn);
        } else g.current = { k: "poly", pts: [sn], cur: sn };
        request();
        return;
      }
      case "text": {
        create({ t: "text", x: sn.x, y: sn.y, text: "Text", size: 9, rotation: 0, color: "#000000" });
        st.setTool("select");
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("volt-symed:focus-text")));
        return;
      }
      case "dyntext": {
        const src = st.toolOpts.dynSource;
        const user = src === "__user";
        create({ t: "dyntext", x: sn.x, y: sn.y, from: user ? "UserText" : "ElementInfo", info: user ? undefined : src, text: user ? "Text" : "", size: 9, rotation: 0, halign: "left", valign: "top", frame: false, width: -1, uuid: newUuid() });
        st.setTool("select");
        if (user) requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("volt-symed:focus-text")));
        return;
      }
      case "pin": {
        const q = pinSnap(p, e.altKey).p;
        const orient = st.toolOpts.pinOrient ?? autoOrient(q, bodyBox(st.doc.prims));
        if (st.doc.pins.some((x) => x.x === q.x && x.y === q.y)) return;
        const number = nextPinNumber(st.doc.pins);
        const pin: PinDef = { id: newUuid(), x: q.x, y: q.y, orient, number, name: number, type: st.toolOpts.pinType || "Generic" };
        st.change((d) => {
          d.pins.push(pin);
        });
        st.setSel([pin.id]);
        return;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const sp = local(e);
    const p = toScene(sp.x, sp.y);
    mouse.current = p;
    const st = useEd.getState();
    const ge = g.current;
    altKey.current = e.altKey;
    const hs = st.tool === "pin" ? pinSnap(p, e.altKey) : smart(p, { alt: e.altKey, exclude: ge.k === "handle" ? ge.id : undefined });
    const prevHint = hint.current;
    hint.current = st.tool !== "select" || ge.k === "handle" ? hs : null;
    if (prevHint?.kind !== hint.current?.kind || prevHint?.p.x !== hint.current?.p.x || prevHint?.p.y !== hint.current?.p.y) request();
    const sn = hs.p;
    curThrottle(sn);
    switch (ge.k) {
      case "pan": {
        view.current.ox = ge.ox + sp.x - ge.sx;
        view.current.oy = ge.oy + sp.y - ge.sy;
        request();
        return;
      }
      case "move": {
        let dx = p.x - ge.start.x, dy = p.y - ge.start.y;
        if (!e.altKey && st.snap) (dx = Math.round(dx / st.grid) * st.grid), (dy = Math.round(dy / st.grid) * st.grid);
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        // moving pins: land the first selected pin on the drawing grid, whatever the editor grid
        if (!e.altKey && st.snap) {
          const p0 = st.gestureBase?.pins.find((q) => st.sel.includes(q.id));
          if (p0) (dx = Math.round((p0.x + dx) / PIN_GRID) * PIN_GRID - p0.x), (dy = Math.round((p0.y + dy) / PIN_GRID) * PIN_GRID - p0.y);
          if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        }
        if (!ge.moved && Math.hypot(dx, dy) * view.current.s < 2) return;
        ge.moved = true;
        const sel = new Set(st.sel);
        if (!ge.base) {
          const gb = st.gestureBase!;
          ge.base = new Map<string, Prim | PinDef>();
          for (const q of gb.prims) if (sel.has(q.id)) ge.base.set(q.id, q);
          for (const q of gb.pins) if (sel.has(q.id)) ge.base.set(q.id, q);
        }
        const base = ge.base;
        st.live((d) => {
          d.prims.forEach((q) => {
            const b0 = base.get(q.id) as Prim | undefined;
            if (!b0) return;
            const b = structuredClone(b0);
            translatePrim(b, dx, dy);
            Object.assign(q, b);
          });
          d.pins.forEach((q) => {
            const b = base.get(q.id) as PinDef | undefined;
            if (!b) return;
            q.x = r1(b.x + dx);
            q.y = r1(b.y + dy);
          });
        });
        return;
      }
      case "handle": {
        st.live((d) => {
          const q = d.prims.find((x) => x.id === ge.id);
          if (q) applyHandle(q as Prim, ge.orig, ge.key, sn, e.shiftKey);
        });
        return;
      }
      case "box":
        ge.cur = p;
        request();
        return;
      case "draw2": {
        if (Math.hypot(sp.x - ge.sx, sp.y - ge.sy) > 4 && e.buttons & 1) ge.dragged = true;
        ge.cur = constrain(ge.tool, ge.start, sn, e.shiftKey);
        request();
        return;
      }
      case "arc":
        ge.cur = sn;
        request();
        return;
      case "poly": {
        const last = ge.pts[ge.pts.length - 1];
        ge.cur = e.shiftKey && last ? ortho(last, sn) : sn;
        request();
        return;
      }
    }
    if (st.tool === "select") {
      const h = handleAt(sp);
      const id = h ? null : hitAt(p);
      st.setHover(id);
      cvs.current!.style.cursor = h ? (h.h.kind === "angle" ? "crosshair" : "move") : id ? "move" : space.current ? "grab" : "default";
    } else {
      cvs.current!.style.cursor = space.current ? "grab" : "crosshair";
      request();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const ge = g.current;
    const st = useEd.getState();
    try {
      cvs.current?.releasePointerCapture(e.pointerId);
    } catch {}
    switch (ge.k) {
      case "pan":
        g.current = { k: "none" };
        return;
      case "move":
      case "handle":
        st.end();
        g.current = { k: "none" };
        return;
      case "box": {
        const a = ge.start, b = ge.cur;
        const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        g.current = { k: "none" };
        if (r.w * view.current.s < 3 && r.h * view.current.s < 3) {
          request();
          return;
        }
        const crossing = b.x < a.x;
        const ids: string[] = [];
        const inside = (bb: Rect | null) => !!bb && (crossing ? bb.x <= r.x + r.w && bb.x + bb.w >= r.x && bb.y <= r.y + r.h && bb.y + bb.h >= r.y : bb.x >= r.x && bb.y >= r.y && bb.x + bb.w <= r.x + r.w && bb.y + bb.h <= r.y + r.h);
        for (const q of st.doc.prims) if (inside(boundsOfPrim(q))) ids.push(q.id);
        for (const q of st.doc.pins) if (inside(pinBounds(q))) ids.push(q.id);
        st.setSel(ge.add ? [...new Set([...st.sel, ...ids])] : ids);
        request();
        return;
      }
      case "draw2": {
        if (ge.dragged) {
          commit2(ge.tool, ge.start, ge.cur);
          g.current = { k: "none" };
          request();
        }
        // else: click-click mode continues
        return;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const ge = g.current;
    if (ge.k === "poly") {
      // the dblclick's second pointerdown already added a duplicate point
      finishPoly();
      return;
    }
    const st = useEd.getState();
    if (st.tool === "select") {
      const sp = local(e);
      const id = hitAt(toScene(sp.x, sp.y));
      const p = st.doc.prims.find((x) => x.id === id);
      if (p && (p.t === "text" || (p.t === "dyntext" && p.from !== "ElementInfo"))) window.dispatchEvent(new CustomEvent("volt-symed:focus-text"));
    }
  };

  useEffect(() => {
    const c = cvs.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const sp = local(e);
      const pinch = e.ctrlKey || e.metaKey;
      const wheelLike = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 40 && e.deltaX === 0 && Number.isInteger(e.deltaY));
      if (pinch || wheelLike) {
        const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : pinch ? 0.01 : 0.0018));
        zoomAt(k, sp.x, sp.y);
      } else {
        view.current.ox -= e.shiftKey ? e.deltaY : e.deltaX;
        view.current.oy -= e.shiftKey ? 0 : e.deltaY;
        request();
      }
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [request, zoomAt]);

  const lastCur = useRef(0);
  const curThrottle = (p: Pt) => {
    const now = performance.now();
    if (now - lastCur.current < 50) return;
    lastCur.current = now;
    useEd.getState().set({ cursor: p });
  };

  const commit2 = (tool: "line" | "rect" | "ellipse", a: Pt, b: Pt) => {
    if (a.x === b.x && a.y === b.y) return;
    if (tool === "line") create({ t: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, end1: "none", end2: "none", len1: 1.5, len2: 1.5, style: sty() });
    else {
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: r1(Math.abs(b.x - a.x)), h: r1(Math.abs(b.y - a.y)) };
      if (!r.w || !r.h) return;
      if (tool === "rect") create({ t: "rect", ...r, rx: 0, ry: 0, style: sty() });
      else create({ t: "ellipse", ...r, style: sty() });
    }
  };

  return (
    <div
      ref={wrap}
      tabIndex={0}
      aria-label="Symbol drawing canvas. Use the toolbar or keyboard shortcuts to pick a tool; arrow keys move the selection."
      role="application"
      className="relative h-full w-full overflow-hidden"
      style={{ outline: "none" }}
      onPointerLeave={() => {
        mouse.current = null;
        hint.current = null;
        useEd.getState().setHover(null);
        request();
      }}
    >
      <canvas
        ref={cvs}
        className="absolute inset-0 touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          if (g.current.k === "poly") {
            e.preventDefault();
            finishPoly();
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function sty() {
  return { lineStyle: "normal" as const, lineWeight: "normal" as const, filling: "none", color: "black" };
}

function ortho(a: Pt, b: Pt): Pt {
  return Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

function constrain(tool: "line" | "rect" | "ellipse", a: Pt, b: Pt, shift: boolean): Pt {
  if (!shift) return b;
  if (tool === "line") {
    const dx = b.x - a.x, dy = b.y - a.y;
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return { x: r1(a.x + Math.cos(ang) * len), y: r1(a.y + Math.sin(ang) * len) };
  }
  const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return { x: a.x + s * Math.sign(b.x - a.x || 1), y: a.y + s * Math.sign(b.y - a.y || 1) };
}

/** Arc from centre, start point (radius + start angle) and end point (sweep, shortest direction). */
function arcFrom(c: Pt, s: Pt, e: Pt) {
  const r = Math.max(0.5, Math.hypot(s.x - c.x, s.y - c.y));
  const box = { x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r };
  const a0 = qetAngle(s, box);
  const a1 = qetAngle(e, box);
  let sweep = a1 - a0;
  while (sweep > 180) sweep -= 360;
  while (sweep < -180) sweep += 360;
  return { x: r1(box.x), y: r1(box.y), w: r1(box.w), h: r1(box.h), start: r1(((a0 % 360) + 360) % 360), angle: r1(sweep) };
}

function bodyBox(prims: EdPrim[]): Rect | null {
  return symbolBounds({ prims: prims.filter((p) => p.t !== "text" && p.t !== "dyntext"), pins: [] });
}

function drawHandle(ctx: CanvasRenderingContext2D, p: Pt, h: Handle, th: Theme) {
  ctx.fillStyle = h.kind === "angle" ? th.accent : th.dark ? "#1b1b1e" : "#ffffff";
  ctx.strokeStyle = th.accent;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  if (h.kind === "angle" || h.kind === "point") ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  else ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7);
  ctx.fill();
  ctx.stroke();
}

function sizeLabel(ctx: CanvasRenderingContext2D, p: Pt, text: string, th: Theme) {
  ctx.save();
  ctx.font = "500 10.5px ui-sans-serif, system-ui, sans-serif";
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = th.accent;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(p.x + 10, p.y + 8, w, 16);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, p.x + 14, p.y + 16);
  ctx.restore();
}
