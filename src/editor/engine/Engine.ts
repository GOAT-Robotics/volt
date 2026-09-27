"use client";
import RBush from "rbush";
import { produce } from "immer";
import type { Doc, ElemInst, ElementDef, Page, Pt, Rect, Styles, TextRole } from "@/core/model";
import { inflate, normRect, rectInside, rectsIntersect, rotOrient, snapGrid, toScene, toLocal, eqPt, dist } from "@/core/geometry";
import { CanvasPainter, imageLoadListeners, measureText } from "@/core/render/canvas";
import { DASHES, PathBuilder } from "@/core/render/painter";
import { cableLabelRect, contentBounds, docStyles, drawPage, elementBounds, layoutElementTexts, mateLabelLayout, pageGeometry, textBounds, freeTextBounds, wireStroke, drawElement } from "@/core/render/scene";
import { symbolFor } from "@/core/render/symbol";
import { deepMerge } from "@/core/styles";
import {
  addWire,
  applyAutoConnections,
  emptySel,
  findAutoConnections,
  getPage,
  hitWire,
  cloneSel,
  moveSelection,
  newElement,
  reattachEnd,
  selSize,
  type EndTarget,
  type Sel,
} from "@/core/ops";
import { moveSegment, orthoRoute } from "@/core/wires";
import { computeNets } from "@/core/topology";
import { shapeBounds, shapeDistance, shapeOutline } from "@/core/shapes";
import { cableMarks, computeCableMarks } from "@/core/wiring";
import { nearestSegment } from "@/core/wires";
import { cachedXref, describe, occurrenceAt, targetsOf, type Occurrence } from "@/core/xref";
import { uid } from "@/core/ids";
import type { DrawKind, EditorStore } from "../store";
import { pinDegree, snapPoint, type IndexItem, type Snap } from "./snap";

type StoreApi = { getState(): EditorStore; subscribe(l: (s: EditorStore, p: EditorStore) => void): () => void };

export type EngineHooks = {
  onEditText?(t: { kind: "free" | "element"; id: string; textId?: string; info?: string | null; value: string; rect: Rect; size: number }): void;
  onNewComment?(a: { pageId: string; anchor: { type: string; id?: string; x: number; y: number }; screen: Pt }): void;
  onAnnounce?(msg: string): void;
  onToast?(msg: string, undo?: boolean): void;
  onView?(): void;
  onFps?(fps: number): void;
  onFollow?(info: { from: Occurrence; to: Occurrence; index: number; count: number; label: string; canGoBack: boolean }): void;
};

type Mode =
  | { m: "idle" }
  | { m: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { m: "box"; a: Pt; b: Pt; additive: boolean }
  | { m: "press"; at: Pt; screen: Pt; hit: Hit | null; shift: boolean }
  | { m: "move"; start: Pt; delta: Pt; sel: Sel; anchor: Pt; guides: { x?: number; y?: number } }
  | { m: "seg"; wire: string; seg: number; start: Pt; delta: Pt }
  | { m: "end"; wire: string; end: "a" | "b"; snap: Snap | null }
  | { m: "wire"; from: EndTarget; fromOrient: string | null; corners: Pt[]; cur: Pt; snap: Snap | null; hFirst: boolean | undefined }
  | { m: "etext"; el: string; text: string; start: Pt; delta: Pt }
  | { m: "spt"; shape: string; i: number; snap: Snap | null }
  | { m: "draw"; kind: DrawKind; pts: Pt[]; cur: Pt; down: Pt }
  | { m: "clabel"; tag: string; start: Pt; delta: Pt };

type Hit =
  | { k: "el"; id: string }
  | { k: "pin"; el: string; pin: string; p: Pt }
  | { k: "wire"; id: string; seg: number; p: Pt }
  | { k: "wireEnd"; id: string; end: "a" | "b"; p: Pt }
  | { k: "junc"; id: string }
  | { k: "text"; id: string }
  | { k: "etext"; el: string; text: string }
  | { k: "shape"; id: string }
  | { k: "cable"; tag: string; wires: string[] }
  | { k: "cableLabel"; tag: string; wires: string[] }
  | { k: "shapePt"; id: string; i: number; p: Pt }
  | { k: "comment"; id: string };

const HIT_PX = 6;
/** index "sub" id of the texts of a component's info block (dragged as one) */
const INFO_BLOCK = "\u0000info";
/** "sub" id of a mated connector's counterpart label */
const MATE_LABEL = "\u0000mate";
const SNAP_PX = 12;

export class Engine {
  readonly host: HTMLElement;
  private scene: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  view = { s: 1, tx: 0, ty: 0 };
  private index = new RBush<IndexItem>(16);
  private indexed = new Map<string, { ref: unknown; items: IndexItem[] }>();
  private indexedPage: Page | null = null;
  private indexedDefs: Doc["defs"] | null = null;
  private indexedStyles: Styles | null = null;
  private elById = new Map<string, ElemInst>();
  private mode: Mode = { m: "idle" };
  private preview: Doc | null = null;
  private hover: Hit | null = null;
  private snapInd: Snap | null = null;
  private placeGhost: { e: ElemInst; def: ElementDef } | null = null;
  private dirtyScene = true;
  /** only the viewport changed (content identical to the last full render) */
  private viewDirty = false;
  /** snapshot of the last full render, reused (transformed) while panning/zooming heavy drawings */
  private snap: HTMLCanvasElement | null = null;
  private snapView = { s: 1, tx: 0, ty: 0 };
  private heavy = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtyOverlay = true;
  private raf = 0;
  private unsub: (() => void) | null = null;
  private ro: ResizeObserver | null = null;
  private spaceDown = false;
  private altDown = false;
  private lastPointer: Pt | null = null;
  private frameTimes: number[] = [];
  private fitted = false;
  private secondary: boolean;
  private destroyed = false;
  viewListeners = new Set<() => void>();

  constructor(host: HTMLElement, private store: StoreApi, private hooks: EngineHooks = {}, opts: { secondary?: boolean } = {}) {
    this.host = host;
    this.secondary = !!opts.secondary;
    imageLoadListeners.add(this.onImageLoad);
    this.scene = document.createElement("canvas");
    this.overlay = document.createElement("canvas");
    for (const c of [this.scene, this.overlay]) {
      c.style.position = "absolute";
      c.style.inset = "0";
      c.style.width = "100%";
      c.style.height = "100%";
      host.appendChild(c);
    }
    this.overlay.style.touchAction = "none";
    this.overlay.style.outline = "none";
    this.overlay.addEventListener("focus", () => (this.host.dataset.focus = this.overlay.matches(":focus-visible") ? "1" : ""));
    this.overlay.addEventListener("blur", () => (this.host.dataset.focus = ""));
    this.overlay.tabIndex = 0;
    this.overlay.setAttribute("role", "application");
    this.overlay.setAttribute("aria-label", "Diagram canvas. Use V for select, W for wire, arrow keys to nudge, R to rotate, Delete to remove, Ctrl+K for commands.");
    this.sctx = this.scene.getContext("2d", { alpha: false })!;
    this.octx = this.overlay.getContext("2d")!;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.bind();
    this.unsub = store.subscribe((s, p) => this.onStore(s, p));
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.unsub?.();
    imageLoadListeners.delete(this.onImageLoad);
    this.ro?.disconnect();
    this.unbind();
    this.scene.remove();
    this.overlay.remove();
  }

  /* ---------------------------------------------------------------- */
  /* State access                                                      */
  /* ---------------------------------------------------------------- */

  private get s() {
    return this.store.getState();
  }
  private get doc(): Doc {
    if (this.secondary) return this.s.diff?.doc ?? this.s.doc;
    return this.preview ?? this.s.doc;
  }
  private get page(): Page {
    const d = this.doc;
    return d.pages.find((p) => p.id === this.s.pageId) ?? [...d.pages].sort((a, b) => a.order - b.order)[0];
  }
  private get editable() {
    return !this.secondary && (!this.s.version || this.s.version.editable);
  }
  private stylesMemo: { base: Styles; pv: unknown; out: Styles } | null = null;
  private get styles(): Styles {
    const base = docStyles(this.doc);
    const pv = this.s.previewStyles;
    if (!pv || this.secondary) return base;
    if (this.stylesMemo && this.stylesMemo.base === base && this.stylesMemo.pv === pv) return this.stylesMemo.out;
    const out = deepMerge(base, pv as never) as Styles;
    this.stylesMemo = { base, pv, out };
    return out;
  }

  private onStore(s: EditorStore, p: EditorStore) {
    if (s.doc !== p.doc || s.pageId !== p.pageId || s.previewStyles !== p.previewStyles || s.diff !== p.diff) {
      this.dirtyScene = true;
      if (s.pageId !== p.pageId) {
        this.fitted = false;
        this.mode = { m: "idle" };
      }
    }
    if (s.sel !== p.sel || s.highlight !== p.highlight || s.comments !== p.comments || s.activeComment !== p.activeComment) this.dirtyOverlay = true;
    if (s.tool !== p.tool || s.place !== p.place || s.shapeKind !== p.shapeKind) {
      this.mode = { m: "idle" };
      this.placeGhost = null;
      this.overlay.style.cursor = s.tool === "pan" ? "grab" : s.tool === "select" ? "default" : "crosshair";
      this.dirtyOverlay = true;
    }
    if (s.gridVisible !== p.gridVisible) this.dirtyScene = true;
  }

  /* ---------------------------------------------------------------- */
  /* Viewport                                                          */
  /* ---------------------------------------------------------------- */

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    for (const c of [this.scene, this.overlay]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    this.dirtyScene = this.dirtyOverlay = true;
    this.heavy = false;
    if (!this.fitted && this.s.doc) this.fit();
  }

  toWorld(sx: number, sy: number): Pt {
    return { x: (sx - this.view.tx) / this.view.s, y: (sy - this.view.ty) / this.view.s };
  }
  toScreen(p: Pt): Pt {
    return { x: p.x * this.view.s + this.view.tx, y: p.y * this.view.s + this.view.ty };
  }
  worldViewport(): Rect {
    const a = this.toWorld(0, 0), b = this.toWorld(this.w, this.h);
    return normRect(a, b);
  }
  setView(s: number, tx: number, ty: number, silent = false) {
    this.view = { s: Math.min(40, Math.max(0.02, s)), tx, ty };
    this.viewDirty = this.dirtyOverlay = true;
    if (!silent) {
      this.s.set("zoom", this.view.s);
      this.hooks.onView?.();
      this.viewListeners.forEach((l) => l());
    }
  }
  zoomAt(factor: number, sx = this.w / 2, sy = this.h / 2) {
    const ns = Math.min(40, Math.max(0.02, this.view.s * factor));
    const k = ns / this.view.s;
    this.setView(ns, sx - (sx - this.view.tx) * k, sy - (sy - this.view.ty) * k);
  }
  fitRect(r: Rect, pad = 40) {
    if (this.w < 10 || this.h < 10 || r.w <= 0 || r.h <= 0) return;
    const s = Math.min((this.w - pad * 2) / r.w, (this.h - pad * 2) / r.h);
    this.setView(s, this.w / 2 - (r.x + r.w / 2) * s, this.h / 2 - (r.y + r.h / 2) * s);
  }
  fit() {
    if (!this.s.doc) return;
    this.fitted = true;
    this.fitRect(contentBounds(this.doc, this.page, true));
  }
  fitPage() {
    this.fitRect(pageGeometry(this.doc, this.page).total);
  }
  fitContent() {
    this.fitRect(contentBounds(this.doc, this.page, false));
  }
  zoomToSelection() {
    const r = this.selectionBounds(this.s.sel);
    if (r) this.fitRect(inflate(r, 30), 60);
  }
  zoomTo100() {
    const c = this.toWorld(this.w / 2, this.h / 2);
    this.setView(1, this.w / 2 - c.x, this.h / 2 - c.y);
  }
  centerOn(p: Pt, s?: number) {
    const sc = s ?? Math.max(this.view.s, 1.5);
    this.setView(sc, this.w / 2 - p.x * sc, this.h / 2 - p.y * sc);
  }
  /** Keep a secondary engine in lock-step (side-by-side compare). */
  syncFrom(other: Engine) {
    this.setView(other.view.s, other.view.tx, other.view.ty, true);
  }

  /* ---------------------------------------------------------------- */
  /* Spatial index                                                     */
  /* ---------------------------------------------------------------- */

  private ensureIndex() {
    const page = this.page;
    const styles = this.styles;
    if (!page) return;
    const full = this.indexedDefs !== this.doc.defs || this.indexedStyles !== styles;
    if (page === this.indexedPage && !full) return;
    if (full || (this.indexedPage && this.indexedPage.id !== page.id)) {
      this.index.clear();
      this.indexed.clear();
    }
    this.indexedPage = page;
    this.indexedDefs = this.doc.defs;
    this.indexedStyles = styles;
    this.elById = new Map(page.elements.map((e) => [e.id, e]));
    const seen = new Set<string>();
    const upsert = (key: string, ref: unknown, make: () => IndexItem[]) => {
      seen.add(key);
      const cur = this.indexed.get(key);
      if (cur && cur.ref === ref) return;
      if (cur) for (const it of cur.items) this.index.remove(it);
      const items = make();
      this.index.load(items);
      this.indexed.set(key, { ref, items });
    };
    for (const e of page.elements) {
      // a mated connector's label depends on its counterpart too
      upsert("e:" + e.id, e.mate ? page.elements : e, () => {
        const def = this.doc.defs[e.defId];
        if (!def) return [];
        const r = elementBounds(e, def);
        const items: IndexItem[] = [{ minX: r.x - 2, minY: r.y - 2, maxX: r.x + r.w + 2, maxY: r.y + r.h + 2, kind: "el", id: e.id }];
        for (const lt of layoutElementTexts(e, symbolFor(def), styles, measureText)) {
          const tb = textBounds(lt);
          const t = lt.block ? undefined : e.texts.find((x) => x.info !== null ? (e.info[x.info] ?? def.info[x.info]) === lt.text : x.text === lt.text);
          items.push({ minX: tb.x, minY: tb.y, maxX: tb.x + tb.w, maxY: tb.y + tb.h, kind: "etext", id: e.id, sub: lt.block ? INFO_BLOCK : t?.id });
        }
        const ml = e.mate ? mateLabelLayout(this.doc, e, def, page, styles, measureText) : null;
        if (ml) items.push({ minX: ml.x, minY: ml.y, maxX: ml.x + ml.w, maxY: ml.y + ml.h, kind: "etext", id: e.id, sub: MATE_LABEL });
        return items;
      });
    }
    for (const w of page.wires) {
      upsert("w:" + w.id, w, () => {
        const items: IndexItem[] = [];
        for (let i = 0; i < w.pts.length - 1; i++) {
          const a = w.pts[i], b = w.pts[i + 1];
          items.push({ minX: Math.min(a.x, b.x) - 1, minY: Math.min(a.y, b.y) - 1, maxX: Math.max(a.x, b.x) + 1, maxY: Math.max(a.y, b.y) + 1, kind: "wire", id: w.id, seg: i });
        }
        if (w.pts.length === 1) items.push({ minX: w.pts[0].x, minY: w.pts[0].y, maxX: w.pts[0].x, maxY: w.pts[0].y, kind: "wire", id: w.id, seg: 0 });
        return items;
      });
    }
    for (const j of page.junctions) upsert("j:" + j.id, j, () => [{ minX: j.x - 3, minY: j.y - 3, maxX: j.x + 3, maxY: j.y + 3, kind: "junc", id: j.id }]);
    for (const sh of page.shapes)
      upsert("s:" + sh.id, sh, () => {
        if (!sh.pts.length) return [];
        const b = shapeBounds(sh);
        const pad = Math.max(1, sh.width / 2);
        return [{ minX: b.x - pad, minY: b.y - pad, maxX: b.x + b.w + pad, maxY: b.y + b.h + pad, kind: "shape", id: sh.id }];
      });
    for (const t of page.texts)
      upsert("t:" + t.id, t, () => {
        const b = freeTextBounds(t, styles, measureText);
        return [{ minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h, kind: "text", id: t.id }];
      });
    for (const [k, v] of this.indexed)
      if (!seen.has(k)) {
        for (const it of v.items) this.index.remove(it);
        this.indexed.delete(k);
      }
  }

  private selectionBounds(sel: Sel): Rect | null {
    let r: Rect | null = null;
    const page = this.page;
    const add = (x: Rect) => {
      r = r ? normRect({ x: Math.min(r.x, x.x), y: Math.min(r.y, x.y) }, { x: Math.max(r.x + r.w, x.x + x.w), y: Math.max(r.y + r.h, x.y + x.h) }) : x;
    };
    for (const id of sel.elements) {
      const e = page.elements.find((x) => x.id === id);
      const d = e && this.doc.defs[e.defId];
      if (e && d) add(elementBounds(e, d));
    }
    for (const id of sel.wires) {
      const w = page.wires.find((x) => x.id === id);
      if (w) for (const p of w.pts) add({ x: p.x, y: p.y, w: 0, h: 0 });
    }
    for (const id of sel.junctions) {
      const j = page.junctions.find((x) => x.id === id);
      if (j) add({ x: j.x - 2, y: j.y - 2, w: 4, h: 4 });
    }
    for (const id of sel.texts) {
      const t = page.texts.find((x) => x.id === id);
      if (t) add({ x: t.x, y: t.y, w: 40, h: 12 });
    }
    for (const id of sel.shapes ?? []) {
      const sh = page.shapes.find((x) => x.id === id);
      if (sh?.pts.length) add(shapeBounds(sh));
    }
    return r;
  }

  /* ---------------------------------------------------------------- */
  /* Hit testing                                                       */
  /* ---------------------------------------------------------------- */

  hitTest(p: Pt, opts: { pins?: boolean } = {}): Hit | null {
    this.ensureIndex();
    const tol = HIT_PX / this.view.s;
    const page = this.page;
    // comment pins (screen space)
    for (const c of this.s.comments) {
      if (!c.anchor || c.pageId !== page.id) continue;
      const sp = this.toScreen(c.anchor);
      const pp = this.toScreen(p);
      if (Math.abs(sp.x + 9 - pp.x) < 10 && Math.abs(sp.y - 9 - pp.y) < 10) return { k: "comment", id: c.id };
    }
    // vertex handles of a single selected shape
    const selShapes = this.s.sel.shapes ?? [];
    if (selShapes.length === 1 && selSize(this.s.sel) === 1 && this.editable) {
      const sh = page.shapes.find((x) => x.id === selShapes[0]);
      if (sh) for (let i = 0; i < sh.pts.length; i++) if (dist(sh.pts[i], p) <= Math.max(tol, 4 / this.view.s)) return { k: "shapePt", id: sh.id, i, p: sh.pts[i] };
    }
    const hits = this.index.search({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol });
    if (opts.pins !== false) {
      let best: { h: Hit; d: number } | null = null;
      for (const h of hits) {
        if (h.kind !== "el") continue;
        const e = this.elById.get(h.id);
        const def = e && this.doc.defs[e.defId];
        if (!e || !def) continue;
        for (const pin of def.pins) {
          const q = toScene(e, pin);
          const d = dist(q, p);
          if (d <= Math.max(tol, 3) && (!best || d < best.d)) best = { h: { k: "pin", el: e.id, pin: pin.id, p: q }, d };
        }
      }
      if (best) return best.h;
    }
    // junctions
    for (const h of hits) if (h.kind === "junc") return { k: "junc", id: h.id };
    // wire free ends
    for (const h of hits) {
      if (h.kind !== "wire") continue;
      const w = page.wires.find((x) => x.id === h.id);
      if (!w) continue;
      if (dist(w.pts[0], p) <= tol) return { k: "wireEnd", id: w.id, end: "a", p: w.pts[0] };
      if (dist(w.pts[w.pts.length - 1], p) <= tol) return { k: "wireEnd", id: w.id, end: "b", p: w.pts[w.pts.length - 1] };
    }
    // texts first (small targets on top)
    // a line running under a label stays clickable: its stroke wins when the click is right on it
    const onStroke = page.shapes.length ? hits.some((h) => { if (h.kind !== "shape") return false; const sh = page.shapes.find((x) => x.id === h.id); return !!sh && shapeDistance(sh, p) <= tol * 0.35; }) : false;
    if (!onStroke) for (const h of hits) if (h.kind === "text" && p.x >= h.minX && p.x <= h.maxX && p.y >= h.minY && p.y <= h.maxY) return { k: "text", id: h.id };
    for (const h of hits) if (h.kind === "etext" && h.sub && p.x >= h.minX && p.x <= h.maxX && p.y >= h.minY && p.y <= h.maxY) return { k: "etext", el: h.id, text: h.sub };
    // cable labels ("W1 · 4G1,5"): drag to move, click selects the cable
    for (const m of cableMarks(this.doc, page)) {
      const r = cableLabelRect(m, this.styles, measureText);
      if (r && p.x >= r.x - 1 && p.x <= r.x + r.w + 1 && p.y >= r.y - 1 && p.y <= r.y + r.h + 1) return { k: "cableLabel", tag: m.tag, wires: page.wires.filter((w) => w.cable === m.tag).map((w) => w.id) };
    }
    // wires (nearest)
    const wh = hitWire({ ...page, wires: page.wires.filter((w) => hits.some((h) => h.kind === "wire" && h.id === w.id)) }, p, tol);
    // elements: smallest bbox containing p
    let el: { id: string; a: number } | null = null;
    for (const h of hits) {
      if (h.kind !== "el") continue;
      if (p.x < h.minX || p.x > h.maxX || p.y < h.minY || p.y > h.maxY) continue;
      const a = (h.maxX - h.minX) * (h.maxY - h.minY);
      if (!el || a < el.a) el = { id: h.id, a };
    }
    // drawing shapes (lines, rectangles, …): nearest outline, or inside a filled shape
    let sh: { id: string; d: number } | null = null;
    for (const h of hits) {
      if (h.kind !== "shape") continue;
      const shape = page.shapes.find((x) => x.id === h.id);
      if (!shape) continue;
      const d = shapeDistance(shape, p);
      if (d <= tol && (!sh || d < sh.d)) sh = { id: h.id, d };
    }
    // cable marks (the short line crossing a cable's wires) select the whole cable
    for (const m of cableMarks(this.doc, page)) {
      const n = nearestSegment([m.a, m.b], p);
      if (n && n.d <= tol && (!wh || n.d < wh.d)) return { k: "cable", tag: m.tag, wires: page.wires.filter((w) => w.cable === m.tag).map((w) => w.id) };
    }
    if (wh && (!el || wh.d < tol * 0.6)) return { k: "wire", id: wh.w.id, seg: wh.seg, p: wh.p };
    if (sh && !wh && (!el || sh.d < tol * 0.6)) return { k: "shape", id: sh.id };
    if (el) return { k: "el", id: el.id };
    if (wh) return { k: "wire", id: wh.w.id, seg: wh.seg, p: wh.p };
    if (sh) return { k: "shape", id: sh.id };
    return null;
  }

  private snapAt(p: Pt, extra: { excludeEls?: Set<string>; excludeWires?: Set<string>; guideFrom?: Pt[] } = {}): Snap {
    this.ensureIndex();
    const s = this.s;
    return snapPoint(
      this.doc,
      this.page,
      this.index,
      p,
      {
        radius: SNAP_PX / this.view.s,
        grid: this.doc.grid.size,
        order: s.snapSettings.order,
        enabled: s.snapSettings,
        free: this.altDown,
        ...extra,
      },
      this.elById,
      pinDegree(this.page),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  private handlers: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];
  private on<K extends keyof HTMLElementEventMap>(t: EventTarget, ev: K | string, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) {
    t.addEventListener(ev, fn as EventListener, o);
    this.handlers.push([t, ev, fn as EventListener, o]);
  }
  private unbind() {
    for (const [t, ev, fn, o] of this.handlers) t.removeEventListener(ev, fn, o);
  }
  private bind() {
    const o = this.overlay;
    this.on(o, "wheel", (e: WheelEvent) => this.onWheel(e), { passive: false });
    this.on(o, "pointerdown", (e: PointerEvent) => this.onDown(e));
    this.on(o, "pointermove", (e: PointerEvent) => this.onMove(e));
    this.on(o, "pointerup", (e: PointerEvent) => this.onUp(e));
    this.on(o, "pointercancel", () => this.cancel());
    this.on(o, "pointerleave", () => {
      this.hover = null;
      this.snapInd = null;
      this.placeGhost = null;
      this.dirtyOverlay = true;
      this.s.set("cursor", null);
    });
    this.on(o, "dblclick", (e: MouseEvent) => this.onDblClick(e));
    this.on(o, "contextmenu", (e: MouseEvent) => this.onContext(e));
    this.on(o, "dragover", (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("application/x-volt-def") || e.dataTransfer?.types.includes("application/x-volt-block")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    });
    this.on(o, "drop", (e: DragEvent) => this.onDrop(e));
    this.on(window, "keydown", (e: KeyboardEvent) => {
      if (e.key === " " && !isTyping(e)) {
        if (!this.spaceDown) this.overlay.style.cursor = "grab";
        this.spaceDown = true;
      }
      if (e.key === "Alt") this.altDown = true;
      if ((e.key === "Meta" || e.key === "Control") && this.hoverLink && !this.hoverMod) {
        this.hoverMod = true;
        this.overlay.style.cursor = "pointer";
        this.dirtyOverlay = true;
      }
    });
    this.on(window, "keyup", (e: KeyboardEvent) => {
      if (e.key === " ") {
        this.spaceDown = false;
        this.overlay.style.cursor = this.s.tool === "select" ? "default" : "crosshair";
      }
      if (e.key === "Alt") this.altDown = false;
      if ((e.key === "Meta" || e.key === "Control") && this.editable && this.hoverMod) {
        this.hoverMod = false;
        this.overlay.style.cursor = "default";
        this.dirtyOverlay = true;
      }
    });
    this.on(window, "blur", () => {
      this.spaceDown = false;
      this.altDown = false;
    });
  }

  private local(e: MouseEvent): Pt {
    const r = this.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    if (e.ctrlKey || e.metaKey || !isTrackpadPan(e)) {
      // pinch-zoom (ctrl) or mouse wheel
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    } else {
      this.setView(this.view.s, this.view.tx - e.deltaX, this.view.ty - e.deltaY);
    }
  }

  private onDown(e: PointerEvent) {
    if (this.destroyed) return;
    this.overlay.focus({ preventScroll: true });
    const sp = this.local(e);
    const wp = this.toWorld(sp.x, sp.y);
    const s = this.s;
    if (e.button === 1 || (e.button === 0 && (this.spaceDown || s.tool === "pan"))) {
      this.overlay.setPointerCapture(e.pointerId);
      this.mode = { m: "pan", sx: sp.x, sy: sp.y, tx: this.view.tx, ty: this.view.ty };
      this.overlay.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;
    this.overlay.setPointerCapture(e.pointerId);
    const editable = this.editable;

    if (s.tool === "place" && editable) {
      this.commitPlace(wp);
      return;
    }
    if (s.tool === "comment") {
      const hit = this.hitTest(wp, { pins: false });
      const anchor = hit && (hit.k === "el" || hit.k === "wire" || hit.k === "text") ? { type: hit.k === "el" ? "element" : hit.k, id: hit.id, x: wp.x, y: wp.y } : { type: "point", x: wp.x, y: wp.y };
      this.hooks.onNewComment?.({ pageId: this.page.id, anchor, screen: sp });
      return;
    }
    if (s.tool === "text" && editable) {
      const p = { x: snapGrid(wp.x, this.doc.grid.size), y: snapGrid(wp.y, this.doc.grid.size) };
      const id = uid();
      s.apply("Add text", (d) => getPage(d, s.pageId).texts.push({ id, x: p.x, y: p.y, text: "Text", role: "annotation", rich: {} }), { sel: { ...emptySel(), texts: [id] } });
      s.setTool("select");
      requestAnimationFrame(() => this.editFreeText(id));
      return;
    }
    if (s.tool === "shape" && editable) {
      this.drawDown(wp, sp, e.shiftKey);
      return;
    }
    if (s.tool === "wire" && editable) {
      if (this.mode.m === "wire") {
        this.wireClick(wp);
        return;
      }
      const sn = this.snapAt(wp);
      this.startWire(sn);
      return;
    }
    // select tool — labels are links: ⌘/Ctrl-click (or plain click on read-only versions) follows them
    const link = this.linkAt(wp);
    if (link && (e.metaKey || e.ctrlKey || !this.editable)) {
      this.follow(link);
      return;
    }
    const hit = this.hitTest(wp);
    if (hit?.k === "comment") {
      s.set("activeComment", hit.id);
      s.set("panels", { ...s.panels, right: "review" });
      return;
    }
    this.mode = { m: "press", at: wp, screen: sp, hit, shift: e.shiftKey || e.metaKey || e.ctrlKey };
  }

  private onMove(e: PointerEvent) {
    const sp = this.local(e);
    const wp = this.toWorld(sp.x, sp.y);
    this.lastPointer = wp;
    this.altDown = e.altKey;
    const s = this.s;
    s.set("cursor", wp);
    const m = this.mode;
    switch (m.m) {
      case "pan":
        this.setView(this.view.s, m.tx + sp.x - m.sx, m.ty + sp.y - m.sy);
        return;
      case "press": {
        const dragged = Math.hypot(sp.x - m.screen.x, sp.y - m.screen.y) > 3;
        if (!dragged) return;
        this.beginDrag(m, wp);
        return;
      }
      case "box":
        m.b = wp;
        this.dirtyOverlay = true;
        return;
      case "move": {
        const raw = { x: wp.x - m.start.x, y: wp.y - m.start.y };
        const g = this.doc.grid.size;
        // snap the anchor (primary hotspot) to grid, then refine with pin guides
        let d = this.altDown ? raw : { x: snapGrid(m.anchor.x + raw.x, g) - m.anchor.x, y: snapGrid(m.anchor.y + raw.y, g) - m.anchor.y };
        const guides: { x?: number; y?: number } = {};
        if (!this.altDown && s.snapSettings.guides) {
          const gd = this.pinGuides(m.sel, d);
          if (gd.x !== undefined) (d = { ...d, x: gd.dx! }), (guides.x = gd.x);
          if (gd.y !== undefined) (d = { ...d, y: gd.dy! }), (guides.y = gd.y);
        }
        if (d.x !== m.delta.x || d.y !== m.delta.y) {
          m.delta = d;
          m.guides = guides;
          const pid = s.pageId;
          this.preview = produce(s.doc, (dr) => moveSelection(dr, getPage(dr, pid), m.sel, d));
          this.dirtyScene = true;
        }
        this.dirtyOverlay = true;
        return;
      }
      case "seg": {
        const g = this.doc.grid.size;
        const d = { x: Math.round((wp.x - m.start.x) / g) * g, y: Math.round((wp.y - m.start.y) / g) * g };
        if (d.x !== m.delta.x || d.y !== m.delta.y) {
          m.delta = d;
          const pid = s.pageId;
          this.preview = produce(s.doc, (dr) => {
            const w = getPage(dr, pid).wires.find((x) => x.id === m.wire);
            if (w) w.pts = moveSegment(w.pts, m.seg, d);
          });
          this.dirtyScene = true;
        }
        return;
      }
      case "end": {
        const sn = this.snapAt(wp, { excludeWires: new Set([m.wire]) });
        m.snap = sn;
        this.snapInd = sn;
        const pid = s.pageId;
        this.preview = produce(s.doc, (dr) => {
          const w = getPage(dr, pid).wires.find((x) => x.id === m.wire);
          if (w) {
            const pts = [...w.pts];
            if (m.end === "a") pts[0] = sn.p;
            else pts[pts.length - 1] = sn.p;
            w.pts = pts;
          }
        });
        this.dirtyScene = this.dirtyOverlay = true;
        return;
      }
      case "wire": {
        const last = m.corners[m.corners.length - 1];
        const sn = this.snapAt(wp, { guideFrom: [last, ...this.nearbyPins(wp)] });
        m.cur = sn.p;
        m.snap = sn;
        this.snapInd = sn;
        this.dirtyOverlay = true;
        return;
      }
      case "spt": {
        const sn = this.snapAt(wp, {});
        m.snap = sn;
        this.snapInd = sn;
        const pid = s.pageId;
        this.preview = produce(s.doc, (dr) => {
          const sh = getPage(dr, pid).shapes.find((x) => x.id === m.shape);
          if (sh) sh.pts[m.i] = { ...sn.p };
        });
        this.dirtyScene = this.dirtyOverlay = true;
        return;
      }
      case "clabel": {
        m.delta = { x: wp.x - m.start.x, y: wp.y - m.start.y };
        const pid = s.pageId;
        this.preview = produce(s.doc, (dr) => this.moveCableLabel(dr, pid, m.tag, m.delta));
        this.dirtyScene = true;
        return;
      }
      case "draw": {
        m.cur = this.drawPoint(wp, e.shiftKey, m);
        this.dirtyOverlay = true;
        return;
      }
      case "etext": {
        m.delta = { x: wp.x - m.start.x, y: wp.y - m.start.y };
        const pid = s.pageId;
        this.preview = produce(s.doc, (dr) => this.moveElementText(dr, pid, m.el, m.text, m.delta));
        this.dirtyScene = true;
        return;
      }
    }
    // idle: hover / snap feedback
    if (s.tool === "place") {
      this.updatePlaceGhost(wp);
      return;
    }
    if (s.tool === "wire" || (s.tool === "shape" && this.editable)) {
      this.snapInd = this.snapAt(wp);
      this.dirtyOverlay = true;
      return;
    }
    const lk = this.linkAt(wp);
    const modHeld = e.metaKey || e.ctrlKey || !this.editable;
    if (lk !== this.hoverLink || modHeld !== this.hoverMod) {
      this.hoverLink = lk;
      this.hoverMod = modHeld;
      this.dirtyOverlay = true;
    }
    if (lk && modHeld) {
      this.overlay.style.cursor = "pointer";
      this.hover = null;
      return;
    }
    const h = this.hitTest(wp);
    if (JSON.stringify(h) !== JSON.stringify(this.hover)) {
      this.hover = h;
      this.dirtyOverlay = true;
      this.overlay.style.cursor = h?.k === "pin" && this.editable ? "crosshair" : h?.k === "wire" && this.editable && this.s.sel.wires.includes(h.id) ? (this.segHorizontal(h.id, h.seg) ? "ns-resize" : "ew-resize") : (h?.k === "wireEnd" || h?.k === "shapePt") && this.editable ? "move" : h ? "pointer" : "default";
    }
  }

  private segHorizontal(wid: string, seg: number) {
    const w = this.page.wires.find((x) => x.id === wid);
    if (!w) return true;
    return Math.abs(w.pts[seg].y - w.pts[seg + 1].y) < 0.01;
  }

  private beginDrag(m: Extract<Mode, { m: "press" }>, wp: Pt) {
    const s = this.s;
    const hit = m.hit;
    if (!this.editable || !hit) {
      this.mode = { m: "box", a: m.at, b: wp, additive: m.shift };
      return;
    }
    if (hit.k === "pin") {
      const sn: Snap = { kind: "pin", p: hit.p, target: { k: "pin", el: hit.el, pin: hit.pin, p: hit.p }, label: "", orient: null };
      const e = this.elById.get(hit.el);
      const def = e && this.doc.defs[e.defId];
      const pin = def?.pins.find((p) => p.id === hit.pin);
      if (e && pin) {
        sn.orient = rotOrient(pin.orient, e.rot, e.mirror);
      }
      this.startWire(sn, true);
      return;
    }
    if (hit.k === "wireEnd") {
      this.mode = { m: "end", wire: hit.id, end: hit.end, snap: null };
      return;
    }
    if (hit.k === "shapePt") {
      this.mode = { m: "spt", shape: hit.id, i: hit.i, snap: null };
      return;
    }
    if (hit.k === "cableLabel") {
      this.mode = { m: "clabel", tag: hit.tag, start: m.at, delta: { x: 0, y: 0 } };
      return;
    }
    if (hit.k === "wire" && s.sel.wires.includes(hit.id) && s.sel.wires.length === 1 && selSize(s.sel) === 1) {
      this.mode = { m: "seg", wire: hit.id, seg: hit.seg, start: m.at, delta: { x: 0, y: 0 } };
      return;
    }
    if (hit.k === "etext" && s.sel.elements.length === 1 && s.sel.elements[0] === hit.el) {
      this.mode = { m: "etext", el: hit.el, text: hit.text, start: m.at, delta: { x: 0, y: 0 } };
      return;
    }
    // ensure hit is selected, then move the selection
    let sel = s.sel;
    const id = hit.k === "el" || hit.k === "junc" || hit.k === "text" || hit.k === "wire" || hit.k === "shape" ? hit.id : hit.k === "etext" ? hit.el : hit.k === "cable" ? hit.tag : null;
    if (id && !this.inSel(sel, hit)) {
      sel = this.selFor(hit, m.shift ? sel : emptySel());
      s.setSel(sel);
    }
    const locked = sel.elements.some((eid) => this.elById.get(eid)?.locked);
    if (locked && sel.elements.length === 1) {
      this.hooks.onToast?.("Element is locked");
      this.mode = { m: "idle" };
      return;
    }
    const first = sel.elements[0] ? this.elById.get(sel.elements[0]) : null;
    const anchor = first ? { x: first.x, y: first.y } : { x: snapGrid(m.at.x, this.doc.grid.size), y: snapGrid(m.at.y, this.doc.grid.size) };
    this.mode = { m: "move", start: m.at, delta: { x: 0, y: 0 }, sel, anchor, guides: {} };
  }

  private inSel(sel: Sel, h: Hit) {
    if (h.k === "el") return sel.elements.includes(h.id);
    if (h.k === "etext") return sel.elements.includes(h.el);
    if (h.k === "wire") return sel.wires.includes(h.id);
    if (h.k === "junc") return sel.junctions.includes(h.id);
    if (h.k === "text") return sel.texts.includes(h.id);
    if (h.k === "shape" || h.k === "shapePt") return (sel.shapes ?? []).includes(h.id);
    if (h.k === "cable" || h.k === "cableLabel") return h.wires.length > 0 && h.wires.every((id) => sel.wires.includes(id));
    return false;
  }
  private selFor(h: Hit, base: Sel): Sel {
    const s = cloneSel(base);
    const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.splice(arr.indexOf(id), 1) : arr.push(id));
    if (h.k === "el") toggle(s.elements, h.id);
    else if (h.k === "etext") toggle(s.elements, h.el);
    else if (h.k === "wire" || h.k === "wireEnd") toggle(s.wires, h.id);
    else if (h.k === "junc") toggle(s.junctions, h.id);
    else if (h.k === "text") toggle(s.texts, h.id);
    else if (h.k === "pin") toggle(s.elements, h.el);
    else if (h.k === "shape") toggle(s.shapes, h.id);
    else if (h.k === "cable" || h.k === "cableLabel") {
      for (const id of h.wires) if (!s.wires.includes(id)) s.wires.push(id);
    }
    else if (h.k === "shapePt" && !s.shapes.includes(h.id)) s.shapes.push(h.id);
    return s;
  }

  private onUp(e: PointerEvent) {
    this.dirtyOverlay = true;
    try {
      this.overlay.releasePointerCapture(e.pointerId);
    } catch {}
    const s = this.s;
    const m = this.mode;
    const wp = this.toWorld(...(Object.values(this.local(e)) as [number, number]));
    switch (m.m) {
      case "pan":
        this.mode = { m: "idle" };
        this.overlay.style.cursor = s.tool === "pan" || this.spaceDown ? "grab" : "default";
        return;
      case "press": {
        // click
        const h = m.hit;
        if (!h) {
          if (!m.shift) s.clearSel();
        } else if (h.k !== "comment") {
          const sel = this.selFor(h, m.shift ? s.sel : emptySel());
          s.setSel(sel);
          this.announceSel(sel);
        }
        this.mode = { m: "idle" };
        return;
      }
      case "box": {
        const r = normRect(m.a, m.b);
        const crossing = m.b.x < m.a.x; // right-to-left = crossing selection
        this.ensureIndex();
        const items = this.index.search({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h });
        const sel = m.additive ? cloneSel(s.sel) : emptySel();
        const add = (arr: string[], id: string) => !arr.includes(id) && arr.push(id);
        const wireIn = new Map<string, boolean>();
        for (const it of items) {
          const ir = { x: it.minX, y: it.minY, w: it.maxX - it.minX, h: it.maxY - it.minY };
          const ok = crossing ? rectsIntersect(ir, r) : rectInside(ir, r);
          if (it.kind === "el" && ok) add(sel.elements, it.id);
          else if (it.kind === "junc" && ok) add(sel.junctions, it.id);
          else if (it.kind === "text" && ok) add(sel.texts, it.id);
          else if (it.kind === "shape" && ok) add(sel.shapes, it.id);
          else if (it.kind === "wire") wireIn.set(it.id, crossing ? (wireIn.get(it.id) || ok) : (wireIn.get(it.id) ?? true) && ok);
        }
        for (const [id, ok] of wireIn) {
          if (!ok) continue;
          if (!crossing) {
            const w = this.page.wires.find((x) => x.id === id);
            if (!w || !w.pts.every((p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)) continue;
          }
          add(sel.wires, id);
        }
        s.setSel(sel);
        this.announceSel(sel);
        this.mode = { m: "idle" };
        this.dirtyOverlay = true;
        return;
      }
      case "move": {
        this.preview = null;
        const d = m.delta;
        this.mode = { m: "idle" };
        if (d.x || d.y) {
          const pid = s.pageId;
          const els = m.sel.elements;
          let auto: ReturnType<typeof findAutoConnections> = [];
          s.apply("Move", (dr) => {
            const pg = getPage(dr, pid);
            moveSelection(dr, pg, m.sel, d);
            auto = findAutoConnections(dr, pg, els);
            applyAutoConnections(pg, auto);
          });
          if (auto.length) this.hooks.onToast?.(`Connected ${auto.length} pin${auto.length > 1 ? "s" : ""} to wire end${auto.length > 1 ? "s" : ""}`, true);
        }
        this.dirtyScene = true;
        return;
      }
      case "seg": {
        this.preview = null;
        this.mode = { m: "idle" };
        if (m.delta.x || m.delta.y) {
          const pid = s.pageId;
          s.apply("Move wire segment", (dr) => {
            const w = getPage(dr, pid).wires.find((x) => x.id === m.wire);
            if (w) w.pts = moveSegment(w.pts, m.seg, m.delta);
          });
        }
        this.dirtyScene = true;
        return;
      }
      case "end": {
        this.preview = null;
        this.mode = { m: "idle" };
        this.snapInd = null;
        const sn = m.snap;
        if (sn) {
          const pid = s.pageId;
          const before = this.page.wires.find((x) => x.id === m.wire)?.[m.end];
          s.apply("Reconnect wire end", (dr) => reattachEnd(dr, getPage(dr, pid), m.wire, m.end, sn.target));
          if (before && before.k !== "free" && sn.target.k === "free") this.hooks.onToast?.("Wire end disconnected — it is now dangling", true);
        }
        this.dirtyScene = true;
        return;
      }
      case "spt": {
        this.preview = null;
        this.mode = { m: "idle" };
        this.snapInd = null;
        const sn = m.snap;
        if (sn) {
          const pid = s.pageId;
          s.apply("Move point", (dr) => {
            const sh = getPage(dr, pid).shapes.find((x) => x.id === m.shape);
            if (sh) sh.pts[m.i] = { ...sn.p };
          });
        }
        this.dirtyScene = true;
        return;
      }
      case "etext": {
        this.preview = null;
        this.mode = { m: "idle" };
        if (Math.hypot(m.delta.x, m.delta.y) > 0.5) {
          const pid = s.pageId;
          s.apply("Move label", (dr) => this.moveElementText(dr, pid, m.el, m.text, m.delta));
        } else {
          s.setSel({ ...emptySel(), elements: [m.el] });
        }
        this.dirtyScene = true;
        return;
      }
      case "clabel": {
        this.preview = null;
        this.mode = { m: "idle" };
        if (Math.hypot(m.delta.x, m.delta.y) > 0.5) {
          const pid = s.pageId;
          s.apply("Move cable label", (dr) => this.moveCableLabel(dr, pid, m.tag, m.delta));
        }
        this.dirtyScene = true;
        return;
      }
      case "draw": {
        // press-drag-release draws a rectangle / ellipse / line in one gesture; a plain click
        // starts it and a second click finishes it
        const sp2 = this.local(e);
        if ((m.kind === "rect" || m.kind === "ellipse" || m.kind === "line") && m.pts.length === 1 && Math.hypot(sp2.x - m.down.x, sp2.y - m.down.y) > 4) {
          m.pts.push(m.cur);
          this.commitDraw();
        }
        return;
      }
      case "wire":
        // click-drag from pin: releasing away from start finishes at the release point
        if (this.dragWire && dist(wp, m.corners[0]) > 4 / this.view.s) {
          this.dragWire = false;
          this.wireClick(wp);
        }
        this.dragWire = false;
        return;
    }
  }
  private dragWire = false;

  /**
   * Drag a cable label: the label goes where it is dropped, and the mark slides along the cable's
   * shared run to the point nearest the label (so the label stays next to its mark).
   */
  private moveCableLabel(d: Doc, pid: string, tag: string, delta: Pt) {
    const page = getPage(d, pid);
    const cable = (d.cables ?? []).find((c) => c.tag === tag);
    // computed directly: the cached marks are keyed on objects that do not change inside this draft
    const cur = computeCableMarks(d, page).find((m) => m.tag === tag);
    if (!cable || !cur) return;
    const r = cableLabelRect(cur, docStyles(d), measureText);
    if (!r) return;
    const L = { x: r.x + delta.x, y: r.y + delta.y };
    const at = cur.horizontal ? L.x + r.w / 2 : L.y + r.h / 2;
    cable.marks = { ...(cable.marks ?? {}), [pid]: { at: Math.round(Math.min(Math.max(at, cur.lo), cur.hi)) } };
    const next = computeCableMarks(d, page).find((m) => m.tag === tag) ?? cur;
    const cx = (next.a.x + next.b.x) / 2, cy = (next.a.y + next.b.y) / 2;
    cable.marks[pid] = { ...cable.marks[pid], label: { x: Math.round((L.x - cx) * 2) / 2, y: Math.round((L.y - cy) * 2) / 2 } };
  }

  private moveElementText(d: Doc, pid: string, elId: string, textId: string, delta: Pt) {
    const page = getPage(d, pid);
    const e = page.elements.find((x) => x.id === elId);
    const def = e && d.defs[e.defId];
    if (e && def && e.mate && textId === MATE_LABEL) {
      // counterpart label: remember where it was dragged, relative to the component (it follows it)
      const cur = mateLabelLayout(d, e, def, page, docStyles(d), measureText);
      if (!cur) return;
      e.mate.labelPos = { x: Math.round((cur.x + delta.x - e.x) * 2) / 2, y: Math.round((cur.y + delta.y - e.y) * 2) / 2 };
      e.mate.label = "show";
      return;
    }
    if (e && def && textId === INFO_BLOCK) {
      // component info block: remember its top-left in element coordinates (it follows the component)
      const cur = layoutElementTexts(e, symbolFor(def), docStyles(d), measureText).find((t) => t.block)?.block;
      if (!cur) return;
      const p = toLocal(e, { x: cur.x + delta.x, y: cur.y + delta.y });
      e.infoLayout = { ...(e.infoLayout ?? {}), at: "free", pos: { x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 } };
      return;
    }
    const t = e?.texts.find((x) => x.id === textId);
    if (!e || !t || !def) return;
    // convert the scene delta into element-local delta (inverse rotation, mirror)
    let lx = delta.x, ly = delta.y;
    for (let i = 0; i < e.rot; i++) [lx, ly] = [ly, -lx];
    if (e.mirror) lx = -lx;
    const k = e.scale && e.scale > 0 ? e.scale : 1;
    ((lx /= k), (ly /= k));
    if (t.x === null || t.y === null) {
      const sym = symbolFor(def);
      const lt = layoutElementTexts({ ...e, texts: [t] }, sym, docStyles(d), measureText)[0];
      const st = docStyles(d).text[t.role];
      const bb = sym.bbox;
      t.x = bb.x + bb.w + 4 + st.dx - 4;
      t.y = bb.y + st.dy - 4;
      void lt;
    }
    t.x = Math.round((t.x + lx) * 2) / 2;
    t.y = Math.round((t.y + ly) * 2) / 2;
  }

  private pinGuides(sel: Sel, d: Pt): { x?: number; dx?: number; y?: number; dy?: number } {
    const moving = new Set(sel.elements);
    if (!moving.size || moving.size > 20) return {};
    const tol = 6 / this.view.s;
    const page = this.s.doc.pages.find((p) => p.id === this.s.pageId)!;
    const doc = this.s.doc;
    const pins: Pt[] = [];
    for (const id of moving) {
      const e = page.elements.find((x) => x.id === id);
      const def = e && doc.defs[e.defId];
      if (e && def) for (const pin of def.pins) pins.push(toScene({ ...e, x: e.x + d.x, y: e.y + d.y }, pin));
    }
    const view = this.worldViewport();
    const others: Pt[] = [];
    for (const e of page.elements) {
      if (moving.has(e.id)) continue;
      const def = doc.defs[e.defId];
      if (!def) continue;
      if (e.x < view.x - 200 || e.x > view.x + view.w + 200 || e.y < view.y - 200 || e.y > view.y + view.h + 200) continue;
      for (const pin of def.pins) others.push(toScene(e, pin));
    }
    let bx: { x: number; dx: number; err: number } | null = null, by: { y: number; dy: number; err: number } | null = null;
    for (const p of pins)
      for (const o of others) {
        const ex = Math.abs(o.x - p.x);
        if (ex > 0 && ex < tol && (!bx || ex < bx.err)) bx = { x: o.x, dx: d.x + (o.x - p.x), err: ex };
        const ey = Math.abs(o.y - p.y);
        if (ey > 0 && ey < tol && (!by || ey < by.err)) by = { y: o.y, dy: d.y + (o.y - p.y), err: ey };
      }
    return { x: bx?.x, dx: bx?.dx, y: by?.y, dy: by?.dy };
  }

  private nearbyPins(p: Pt): Pt[] {
    const r = 300;
    const out: Pt[] = [];
    for (const it of this.index.search({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r })) {
      if (it.kind === "junc") {
        const j = this.page.junctions.find((x) => x.id === it.id);
        if (j) out.push(j);
      }
      if (it.kind !== "el") continue;
      const e = this.elById.get(it.id);
      const def = e && this.doc.defs[e.defId];
      if (e && def) for (const pin of def.pins) out.push(toScene(e, pin));
      if (out.length > 200) break;
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Wire tool                                                         */
  /* ---------------------------------------------------------------- */

  private startWire(sn: Snap, fromDrag = false) {
    this.dragWire = fromDrag;
    this.mode = { m: "wire", from: sn.target, fromOrient: sn.orient ?? null, corners: [sn.p], cur: sn.p, snap: null, hFirst: undefined };
    this.hooks.onAnnounce?.(`Wire started at ${sn.label || "point"}. Click to add corners, click a pin or wire to finish, Escape to cancel.`);
    this.dirtyOverlay = true;
  }

  private wirePreview(m: Extract<Mode, { m: "wire" }>): Pt[] {
    const last = m.corners[m.corners.length - 1];
    const first = m.corners.length === 1;
    const to = m.snap?.orient && (m.snap.kind === "pin") ? m.snap.orient : null;
    const route = orthoRoute(last, m.cur, first ? (m.fromOrient as never) : null, to as never, m.hFirst);
    return [...m.corners.slice(0, -1), ...route];
  }

  private wireClick(wp: Pt) {
    const m = this.mode;
    if (m.m !== "wire") return;
    const last = m.corners[m.corners.length - 1];
    const sn = this.snapAt(wp, { guideFrom: [last, ...this.nearbyPins(wp)] });
    m.cur = sn.p;
    m.snap = sn;
    const terminal = sn.kind === "pin" || sn.kind === "junction" || sn.kind === "wire" || sn.kind === "wireEnd";
    if (terminal) {
      if (eqPt(sn.p, m.corners[0]) && m.corners.length === 1) return; // clicked start again
      const pts = this.wirePreview(m);
      this.commitWire(m.from, sn.target, pts, sn);
      this.mode = { m: "idle" };
      this.snapInd = null;
      this.dirtyOverlay = true;
      return;
    }
    // corner: freeze the current route and continue from the click point
    const pts = this.wirePreview(m);
    if (eqPt(pts[pts.length - 1], last)) {
      // double click at same place → finish as dangling end
      if (m.corners.length > 1 || !eqPt(last, m.corners[0])) {
        this.commitWire(m.from, { k: "free", p: last }, m.corners, sn);
        this.mode = { m: "idle" };
      }
      return;
    }
    m.corners = pts;
    m.fromOrient = null;
    this.dirtyOverlay = true;
  }

  private commitWire(from: EndTarget, to: EndTarget, pts: Pt[], sn: Snap) {
    const s = this.s;
    const pid = s.pageId;
    let created: string | null = null;
    s.apply("Add wire", (d) => {
      const w = addWire(getPage(d, pid), from, to, pts);
      created = w?.id ?? null;
    });
    if (created) {
      const msg = to.k === "free" || from.k === "free" ? "Wire added with a dangling end" : sn.createsJunction || to.k === "wire" ? "Wire connected — junction created" : "Wire connected";
      this.hooks.onAnnounce?.(msg);
      if (to.k === "free") this.hooks.onToast?.(msg);
    }
  }

  finishWireAsDangling() {
    const m = this.mode;
    if (m.m === "draw") return this.finishDraw();
    if (m.m !== "wire") return;
    const pts = this.wirePreview(m);
    this.commitWire(m.from, { k: "free", p: pts[pts.length - 1] }, pts, m.snap ?? ({ kind: "none" } as Snap));
    this.mode = { m: "idle" };
    this.dirtyOverlay = true;
  }

  /** Backspace while wiring removes the last corner. */
  undoCorner(): boolean {
    const m = this.mode;
    if (m.m === "draw") {
      if (m.pts.length <= 1) this.cancel();
      else m.pts.pop();
      this.dirtyOverlay = true;
      return true;
    }
    if (m.m !== "wire") return false;
    if (m.corners.length <= 1) {
      this.cancel();
      return true;
    }
    m.corners = m.corners.slice(0, -1);
    const prev = m.corners[m.corners.length - 1];
    if (m.corners.length === 1) {
      // restore orientation of start
      m.corners = [prev];
    }
    this.dirtyOverlay = true;
    return true;
  }

  toggleBend(): boolean {
    const m = this.mode;
    if (m.m !== "wire") return false;
    m.hFirst = m.hFirst === undefined ? false : !m.hFirst;
    m.fromOrient = null;
    this.dirtyOverlay = true;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Shape tool: rectangle, ellipse, line, polygon, polyline            */
  /* ---------------------------------------------------------------- */

  /** snapped point (grid / pins / guides; Alt = free); Shift = square / circle, or 45° steps from the last point */
  private drawPoint(wp: Pt, shift: boolean, m?: Extract<Mode, { m: "draw" }>): Pt {
    const last = m?.pts[m.pts.length - 1];
    const sn = this.snapAt(wp, last ? { guideFrom: [last] } : {});
    this.snapInd = sn;
    let p = { ...sn.p };
    if (shift && m && last) {
      const dx = p.x - last.x, dy = p.y - last.y;
      if ((m.kind === "rect" || m.kind === "ellipse") && m.pts.length === 1) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        p = { x: last.x + Math.sign(dx || 1) * d, y: last.y + Math.sign(dy || 1) * d };
      } else {
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const r = Math.hypot(dx, dy);
        p = { x: last.x + Math.round(Math.cos(a) * r * 100) / 100, y: last.y + Math.round(Math.sin(a) * r * 100) / 100 };
      }
    }
    return p;
  }

  private drawDown(wp: Pt, sp: Pt, shift: boolean) {
    const m = this.mode;
    if (m.m === "draw") {
      const p = this.drawPoint(wp, shift, m);
      if (m.kind === "polygon" || m.kind === "polyline") {
        // clicking the first point closes a polygon
        if (m.kind === "polygon" && m.pts.length >= 3 && dist(p, m.pts[0]) < 8 / this.view.s) return this.finishDraw();
        if (!eqPt(p, m.pts[m.pts.length - 1])) m.pts.push(p);
        m.cur = p;
        this.dirtyOverlay = true;
        return;
      }
      m.pts.push(p);
      this.commitDraw();
      return;
    }
    const p = this.drawPoint(wp, false);
    this.mode = { m: "draw", kind: this.s.shapeKind, pts: [p], cur: p, down: sp };
    this.dirtyOverlay = true;
  }

  /** Enter / double-click / click on the first point: finish a polygon or polyline */
  finishDraw() {
    const m = this.mode;
    if (m.m !== "draw") return;
    if (m.kind === "polygon" || m.kind === "polyline") {
      // a double-click adds the same point twice
      const pts = m.pts.filter((p, i) => i === 0 || !eqPt(p, m.pts[i - 1]));
      m.pts = pts;
    } else if (m.pts.length === 1 && !eqPt(m.cur, m.pts[0])) m.pts.push(m.cur);
    this.commitDraw();
  }

  private commitDraw() {
    const m = this.mode;
    if (m.m !== "draw") return;
    this.mode = { m: "idle" };
    this.snapInd = null;
    this.dirtyOverlay = true;
    const s = this.s;
    const st = s.shapeStyle;
    let shape: import("@/core/model").Shape | null = null;
    const id = uid();
    const base = { id, color: st.color, width: st.width, dash: st.dash };
    if (m.kind === "rect" || m.kind === "ellipse") {
      if (m.pts.length < 2) return;
      const [a, b] = m.pts;
      if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return;
      shape = { ...base, kind: m.kind, pts: [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }], fill: st.fill };
    } else if (m.kind === "line") {
      if (m.pts.length < 2 || eqPt(m.pts[0], m.pts[1])) return;
      shape = { ...base, kind: "line", pts: m.pts.slice(0, 2), fill: null };
    } else {
      const closed = m.kind === "polygon";
      if (m.pts.length < 2 || (closed && m.pts.length < 3)) {
        this.hooks.onToast?.(closed ? "A polygon needs at least 3 points" : "A polyline needs at least 2 points");
        return;
      }
      shape = { ...base, kind: "polygon", closed, pts: m.pts, fill: closed ? st.fill : null };
    }
    const names: Record<DrawKind, string> = { rect: "rectangle", ellipse: "ellipse", line: "line", polygon: "polygon", polyline: "polyline" };
    const sh = shape;
    const pid = s.pageId;
    s.apply(`Draw ${names[m.kind]}`, (d) => void getPage(d, pid).shapes.push(sh), { sel: { ...emptySel(), shapes: [id] } });
    this.hooks.onAnnounce?.(`${names[m.kind][0].toUpperCase()}${names[m.kind].slice(1)} drawn`);
  }

  private drawPreviewPts(m: Extract<Mode, { m: "draw" }>): { kind: "rect" | "ellipse" | "poly"; pts: Pt[]; closed: boolean } {
    if (m.kind === "rect" || m.kind === "ellipse") return { kind: m.kind, pts: [m.pts[0], m.cur], closed: true };
    if (m.kind === "line") return { kind: "poly", pts: [m.pts[0], m.cur], closed: false };
    const pts = eqPt(m.cur, m.pts[m.pts.length - 1]) ? m.pts : [...m.pts, m.cur];
    return { kind: "poly", pts, closed: m.kind === "polygon" && pts.length > 2 };
  }

  isBusy() {
    return this.mode.m !== "idle";
  }

  cancel() {
    if (this.mode.m !== "idle") {
      this.mode = { m: "idle" };
      this.preview = null;
      this.snapInd = null;
      this.dirtyScene = this.dirtyOverlay = true;
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Placement                                                         */
  /* ---------------------------------------------------------------- */

  private updatePlaceGhost(wp: Pt) {
    const pl = this.s.place;
    if (!pl || pl.kind !== "element") return;
    const def = this.s.doc.defs[pl.defId] ?? this.pendingDefs.get(pl.defId);
    if (!def) return;
    const g = this.doc.grid.size;
    const p = this.altDown ? wp : { x: snapGrid(wp.x, g), y: snapGrid(wp.y, g) };
    this.placeGhost = { e: { id: "ghost", defId: def.id, x: p.x, y: p.y, rot: pl.rot, mirror: pl.mirror, info: {}, texts: [] }, def };
    this.dirtyOverlay = true;
  }

  /** Definitions not yet in the doc (picked from the library) */
  pendingDefs = new Map<string, ElementDef>();

  private commitPlace(wp: Pt) {
    const s = this.s;
    const pl = s.place;
    if (!pl) return;
    if (pl.kind === "block") {
      window.dispatchEvent(new CustomEvent("volt:place-block", { detail: { blockId: pl.blockId, at: { x: snapGrid(wp.x, this.doc.grid.size), y: snapGrid(wp.y, this.doc.grid.size) } } }));
      return;
    }
    const def = s.doc.defs[pl.defId] ?? this.pendingDefs.get(pl.defId);
    if (!def) return;
    const g = this.doc.grid.size;
    const p = this.altDown ? wp : { x: snapGrid(wp.x, g), y: snapGrid(wp.y, g) };
    const pid = s.pageId;
    let id = "";
    s.apply(`Place ${def.name}`, (d) => {
      const pg = getPage(d, pid);
      const e = newElement(d, pg, def, p, pl.rot, pl.mirror);
      id = e.id;
      applyAutoConnections(pg, findAutoConnections(d, pg, [e.id]));
    });
    if (id) s.setSel({ ...emptySel(), elements: [id] });
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    const sp = this.local(e);
    const wp = this.toWorld(sp.x, sp.y);
    const defId = e.dataTransfer?.getData("application/x-volt-def");
    const blockId = e.dataTransfer?.getData("application/x-volt-block");
    if (blockId) {
      window.dispatchEvent(new CustomEvent("volt:place-block", { detail: { blockId, at: { x: snapGrid(wp.x, this.doc.grid.size), y: snapGrid(wp.y, this.doc.grid.size) } } }));
      return;
    }
    if (!defId || !this.editable) return;
    const s = this.s;
    const go = () => {
      s.setTool("place", { kind: "element", defId, rot: 0, mirror: false });
      this.commitPlace(wp);
      s.setTool("select");
    };
    if (s.doc.defs[defId] || this.pendingDefs.has(defId)) return go();
    const m = /^lib:(.+)@(\d+)$/.exec(defId);
    if (!m) return;
    import("../defs-client").then(({ loadLibraryDef }) =>
      loadLibraryDef({ id: m[1], revision: Number(m[2]), category: "", status: "" })
        .then((d) => {
          this.pendingDefs.set(d.id, d);
          go();
        })
        .catch(() => this.hooks.onToast?.("Could not load the element")),
    );
  }

  rotatePlacement() {
    const pl = this.s.place;
    if (pl?.kind === "element") {
      this.s.set("place", { ...pl, rot: ((pl.rot + 1) % 4) as 0 | 1 | 2 | 3 });
      if (this.lastPointer) this.updatePlaceGhost(this.lastPointer);
      return true;
    }
    return false;
  }
  mirrorPlacement() {
    const pl = this.s.place;
    if (pl?.kind === "element") {
      this.s.set("place", { ...pl, mirror: !pl.mirror });
      if (this.lastPointer) this.updatePlaceGhost(this.lastPointer);
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Cross references (click a label → go to its other occurrences)     */
  /* ---------------------------------------------------------------- */

  private hoverLink: Occurrence | null = null;
  private hoverMod = false;
  private pendingFocus: { at: Pt } | null = null;
  private flash: { pageId: string; rect: Rect; until: number } | null = null;
  private navStack: { pageId: string; view: { s: number; tx: number; ty: number } }[] = [];

  xref() {
    return cachedXref(this.s.doc, measureText);
  }

  /** Linked label under a scene point (only labels that have somewhere to go). */
  linkAt(p: Pt): Occurrence | null {
    if (this.secondary || !this.s.doc) return null;
    const x = this.xref();
    const o = occurrenceAt(x, this.page.id, p, 2 / this.view.s);
    return o && o.group >= 0 ? o : null;
  }

  /** Follow a label to the next occurrence in its group. */
  follow(from: Occurrence) {
    const x = this.xref();
    const targets = targetsOf(x, from);
    if (!targets.length) return;
    this.goToOccurrence(targets[0], true);
    const g = x.groups[from.group];
    this.hooks.onFollow?.({ from, to: targets[0], index: g.indexOf(targets[0].idx) + 1, count: g.length, label: describe(this.s.doc, targets[0]), canGoBack: this.navStack.length > 0 });
  }

  /** Follow the label of the current selection (keyboard alternative). */
  followSelection(): boolean {
    const sel = this.s.sel;
    const id = sel.elements[0] ?? sel.wires[0];
    if (!id) return false;
    const x = this.xref();
    const o = x.occ.find((q) => q.id === id && q.group >= 0);
    if (!o) return false;
    this.follow(o);
    return true;
  }

  goToOccurrence(o: Occurrence, remember = false) {
    const s = this.s;
    if (remember) {
      this.navStack.push({ pageId: s.pageId, view: { ...this.view } });
      if (this.navStack.length > 50) this.navStack.shift();
    }
    const sel = emptySel();
    if (o.kind === "wire") sel.wires.push(o.id);
    else sel.elements.push(o.id);
    if (s.pageId !== o.pageId) {
      s.setPage(o.pageId);
      this.pendingFocus = { at: o.at };
    } else this.centerOn(o.at, Math.max(this.view.s, 1.6));
    this.s.setSel(sel);
    this.flash = { pageId: o.pageId, rect: o.rect, until: performance.now() + 1400 };
    this.dirtyOverlay = true;
    this.hooks.onAnnounce?.(`Went to ${describe(this.s.doc, o)}`);
  }

  canGoBack() {
    return this.navStack.length > 0;
  }

  goBack(): boolean {
    const b = this.navStack.pop();
    if (!b) return false;
    const s = this.s;
    if (s.pageId !== b.pageId) {
      s.setPage(b.pageId);
      // restore the exact view once the page switch has been processed
      requestAnimationFrame(() => requestAnimationFrame(() => this.setView(b.view.s, b.view.tx, b.view.ty)));
    } else this.setView(b.view.s, b.view.tx, b.view.ty);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Double click / context                                            */
  /* ---------------------------------------------------------------- */

  private onDblClick(e: MouseEvent) {
    const sp = this.local(e);
    const wp = this.toWorld(sp.x, sp.y);
    if (this.mode.m === "wire") {
      this.finishWireAsDangling();
      return;
    }
    if (this.mode.m === "draw") {
      this.finishDraw();
      return;
    }
    if (!this.editable) return;
    const h = this.hitTest(wp, { pins: false });
    if (h?.k === "text") this.editFreeText(h.id);
    else if (h?.k === "etext") this.editElementText(h.el, h.text);
    else if (h?.k === "el") {
      const el = this.elById.get(h.id);
      const t = el?.texts.find((x) => x.info === "label");
      if (el && t) this.editElementText(el.id, t.id);
    } else if (h?.k === "wire") {
      const w = this.page.wires.find((x) => x.id === h.id);
      if (w) {
        const p = this.toScreen(h.p);
        this.hooks.onEditText?.({ kind: "free", id: "wire:" + w.id, value: w.label ?? "", rect: { x: p.x - 40, y: p.y - 12, w: 80, h: 20 }, size: 12 });
      }
    }
  }

  editFreeText(id: string) {
    const t = this.page.texts.find((x) => x.id === id);
    if (!t) return;
    const p = this.toScreen({ x: t.x, y: t.y });
    const st = this.styles.text[t.role];
    this.hooks.onEditText?.({ kind: "free", id, value: t.text, rect: { x: p.x, y: p.y, w: 200, h: 24 }, size: Math.max(11, st.size * (4 / 3) * this.view.s) });
  }

  editElementText(elId: string, textId: string) {
    const e = this.elById.get(elId);
    const t = e?.texts.find((x) => x.id === textId);
    if (!e || !t) return;
    const def = this.doc.defs[e.defId];
    const lt = def && layoutElementTexts(e, symbolFor(def), this.styles, measureText).find((x) => x.text === (t.info ? e.info[t.info] ?? def.info[t.info] : t.text));
    const anchor = lt ? { x: lt.x, y: lt.y } : { x: e.x, y: e.y };
    const p = this.toScreen(anchor);
    this.hooks.onEditText?.({ kind: "element", id: elId, textId, info: t.info, value: t.info ? e.info[t.info] ?? "" : t.text, rect: { x: p.x, y: p.y, w: 120, h: 22 }, size: Math.max(11, (lt?.style.size ?? 9) * (4 / 3) * this.view.s) });
  }

  private onContext(e: MouseEvent) {
    const sp = this.local(e);
    const wp = this.toWorld(sp.x, sp.y);
    if (this.mode.m === "wire") {
      e.preventDefault();
      e.stopPropagation();
      this.finishWireAsDangling();
      return;
    }
    const h = this.hitTest(wp, { pins: false });
    if (h && !this.inSel(this.s.sel, h)) this.s.setSel(this.selFor(h, emptySel()));
    if (!h) this.s.clearSel();
    this.lastPointer = wp;
  }

  get contextPoint() {
    return this.lastPointer;
  }

  /* ---------------------------------------------------------------- */
  /* Selection helpers                                                 */
  /* ---------------------------------------------------------------- */

  selectNet(fromSel?: Sel) {
    const sel = fromSel ?? this.s.sel;
    const page = this.s.page();
    const nets = computeNets(page, this.s.doc);
    const out = emptySel();
    const hl = new Set<string>();
    for (const n of nets) {
      const hit = n.wires.some((w) => sel.wires.includes(w)) || n.junctions.some((j) => sel.junctions.includes(j)) || n.pins.some((p) => sel.elements.includes(p.el));
      if (!hit) continue;
      out.wires.push(...n.wires);
      out.junctions.push(...n.junctions);
      n.wires.forEach((w) => hl.add(w));
      n.pins.forEach((p) => hl.add(p.el + "/" + p.pin));
    }
    this.s.setSel(out);
    this.s.set("highlight", hl);
    this.hooks.onAnnounce?.(`Net selected: ${out.wires.length} wires`);
  }

  private announceSel(sel: Sel) {
    const n = selSize(sel);
    if (!n) return this.hooks.onAnnounce?.("Selection cleared");
    if (sel.elements.length === 1 && n === 1) {
      const e = this.elById.get(sel.elements[0]);
      const def = e && this.doc.defs[e.defId];
      if (e && def) {
        const deg = pinDegree(this.page);
        const conn = def.pins.filter((p) => deg.has(e.id + "/" + p.id)).length;
        return this.hooks.onAnnounce?.(`Selected ${e.info.label || ""} ${def.name}, ${def.pins.length} pins, ${conn} connected`);
      }
    }
    this.hooks.onAnnounce?.(`${n} objects selected`);
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  requestRender() {
    this.dirtyScene = this.dirtyOverlay = true;
  }

  private onImageLoad = () => this.requestRender();

  private loop(t: number) {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.s.doc) return;
    if (!this.fitted) {
      this.resize();
      if (!this.fitted) this.fit();
    }
    if (this.pendingFocus && this.fitted) {
      const f = this.pendingFocus;
      this.pendingFocus = null;
      this.centerOn(f.at, Math.max(this.view.s, 1.6));
    }
    if (this.flash && performance.now() < this.flash.until) this.dirtyOverlay = true;
    if (this.secondary) {
      // secondary follows the store diff doc
    }
    const t0 = performance.now();
    let drew = false;
    if (this.dirtyScene) {
      this.dirtyScene = false;
      this.viewDirty = false;
      this.renderScene();
      this.takeSnapshot();
      drew = true;
    } else if (this.viewDirty) {
      this.viewDirty = false;
      if (this.heavy && this.snap) {
        // heavy drawing: show the transformed last frame now, re-render crisply once motion settles
        this.blitSnapshot();
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          this.dirtyScene = true;
        }, 110);
      } else {
        this.renderScene();
        this.takeSnapshot();
      }
      drew = true;
    }
    if (this.dirtyOverlay) {
      this.dirtyOverlay = false;
      this.renderOverlay();
      drew = true;
    }
    if (drew) {
      const dt = performance.now() - t0;
      this.lastFrameWorkMs = dt;
      this.frameTimes.push(dt);
      if (this.frameTimes.length >= 30) {
        const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
        this.hooks.onFps?.(Math.min(120, Math.round(1000 / Math.max(avg, 1000 / 120))));
        this.frameTimes = [];
      }
    }
    void t;
  }

  private takeSnapshot() {
    this.heavy = this.lastRenderMs > 9;
    if (!this.heavy) return;
    if (!this.snap) this.snap = document.createElement("canvas");
    if (this.snap.width !== this.scene.width || this.snap.height !== this.scene.height) {
      this.snap.width = this.scene.width;
      this.snap.height = this.scene.height;
    }
    const c = this.snap.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.scene, 0, 0);
    this.snapView = { ...this.view };
  }

  private blitSnapshot() {
    const c = this.sctx;
    const k = this.view.s / this.snapView.s;
    const dx = (this.view.tx - this.snapView.tx * k) * this.dpr;
    const dy = (this.view.ty - this.snapView.ty * k) * this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = getComputedStyle(this.host).getPropertyValue("--canvas").trim() || "#fcfcfd";
    c.fillRect(0, 0, this.scene.width, this.scene.height);
    c.imageSmoothingEnabled = true;
    c.setTransform(k, 0, 0, k, dx, dy);
    c.drawImage(this.snap!, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Work done in the last drawn frame (ms), including snapshot blits. */
  lastFrameWorkMs = 0;
  /** Last render cost in ms (used by perf tests). */
  lastRenderMs = 0;

  private renderScene() {
    const t0 = performance.now();
    const c = this.sctx;
    const dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    const css = getComputedStyle(this.host);
    c.fillStyle = css.getPropertyValue("--canvas").trim() || "#fcfcfd";
    c.fillRect(0, 0, this.scene.width, this.scene.height);
    this.ensureIndex();
    const doc = this.doc;
    const page = this.page;
    if (!page) return;
    const { s, tx, ty } = this.view;
    const base: [number, number, number, number, number, number] = [s * dpr, 0, 0, s * dpr, tx * dpr, ty * dpr];

    // page paper
    const geo = pageGeometry(doc, page);
    c.setTransform(...base);
    c.fillStyle = "#ffffff";
    c.shadowColor = "rgba(0,0,0,0.08)";
    c.shadowBlur = 12 * dpr;
    c.fillRect(geo.total.x - 5, geo.total.y - 5, geo.total.w + 10, geo.total.h + 10);
    c.shadowBlur = 0;

    if (this.s.gridVisible && this.doc.grid.show) this.drawGrid(c, geo.total);

    const vr = inflate(this.worldViewport(), 20);
    const items = this.index.search({ minX: vr.x, minY: vr.y, maxX: vr.x + vr.w, maxY: vr.y + vr.h });
    const ids = { el: new Set<string>(), wire: new Set<string>(), junc: new Set<string>(), text: new Set<string>() };
    for (const it of items) {
      if (it.kind === "el" || it.kind === "etext") ids.el.add(it.id);
      else if (it.kind === "wire") ids.wire.add(it.id);
      else if (it.kind === "junc") ids.junc.add(it.id);
      else if (it.kind === "text") ids.text.add(it.id);
    }
    const painter = new CanvasPainter(c, base, dpr);
    const diff = this.s.diff;
    let tint: Map<string, string> | undefined;
    if (diff && diff.mode === "overlay" && !this.secondary) {
      const col = this.styles.graphics.review;
      tint = new Map();
      for (const [id, k] of diff.diff.tintB) tint.set(id, k === "added" ? col.added : k === "removed" ? col.removed : k === "moved" ? "#0ea5e9" : col.changed);
      // ghost of removed items from the compared version
      const other = diff.doc.pages.find((p) => p.id === page.id);
      if (other) {
        const removedEls = other.elements.filter((e) => diff.diff.tintA.get(e.id) === "removed");
        const removedWires = other.wires.filter((w) => diff.diff.tintA.get(w.id) === "removed");
        const rt = new Map<string, string>();
        for (const e of removedEls) rt.set(e.id, col.removed);
        for (const w of removedWires) rt.set(w.id, col.removed);
        drawPage(painter, { doc: diff.doc, page: other, elements: removedEls, wires: removedWires, junctions: [], texts: [], decor: false, lod: s, tint: rt, alpha: 0.55 });
      }
    } else if (this.secondary && diff) {
      const col = this.styles.graphics.review;
      tint = new Map();
      for (const [id, k] of diff.diff.tintA) tint.set(id, k === "removed" ? col.removed : k === "moved" ? "#0ea5e9" : col.changed);
    }
    drawPage(painter, {
      doc,
      page,
      styles: this.styles,
      // pass the page arrays themselves when everything is visible: lets render caches hit
      elements: ids.el.size >= page.elements.length ? page.elements : page.elements.filter((e) => ids.el.has(e.id)),
      wires: ids.wire.size >= page.wires.length ? page.wires : page.wires.filter((w) => ids.wire.has(w.id)),
      junctions: ids.junc.size >= page.junctions.length ? page.junctions : page.junctions.filter((j) => ids.junc.has(j.id)),
      texts: ids.text.size >= page.texts.length ? page.texts : page.texts.filter((t) => ids.text.has(t.id)),
      lod: s,
      editor: { pins: !this.secondary, dangling: !this.secondary },
      tint,
      version: this.s.version?.label,
    });
    this.lastRenderMs = performance.now() - t0;
  }

  private drawGrid(c: CanvasRenderingContext2D, pageRect: Rect) {
    const g = this.doc.grid.size;
    let step = g;
    while (step * this.view.s < 7) step *= 5;
    const vr = this.worldViewport();
    const x0 = Math.max(vr.x, pageRect.x), y0 = Math.max(vr.y, pageRect.y);
    const x1 = Math.min(vr.x + vr.w, pageRect.x + pageRect.w), y1 = Math.min(vr.y + vr.h, pageRect.y + pageRect.h);
    if (x1 <= x0 || y1 <= y0) return;
    const dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "rgba(100,116,139,0.35)";
    const size = Math.max(1, Math.round(dpr * (step === g && this.view.s > 2 ? 1.5 : 1)));
    const sx = snapGrid(x0, step) - step, sy = snapGrid(y0, step) - step;
    let n = 0;
    for (let x = sx; x <= x1; x += step) {
      if (x < x0) continue;
      const px = Math.round((x * this.view.s + this.view.tx) * dpr);
      for (let y = sy; y <= y1; y += step) {
        if (y < y0) continue;
        const py = Math.round((y * this.view.s + this.view.ty) * dpr);
        c.fillRect(px - (size >> 1), py - (size >> 1), size, size);
        if (++n > 60000) return;
      }
    }
  }

  private renderOverlay() {
    const c = this.octx;
    const dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const s = this.s;
    if (!s.doc) return;
    const { s: sc, tx, ty } = this.view;
    const base: [number, number, number, number, number, number] = [sc * dpr, 0, 0, sc * dpr, tx * dpr, ty * dpr];
    const painter = new CanvasPainter(c, base, dpr);
    const doc = this.doc;
    const page = this.page;
    const accent = this.styles.graphics.selection;
    const px = (n: number) => n / sc;

    // net highlight
    if (s.highlight) {
      for (const w of page.wires) {
        if (!s.highlight.has(w.id)) continue;
        painter.stroke(new PathBuilder().poly(w.pts).build(), { color: "#f59e0b", width: px(4), cap: "round", join: "round", alpha: 0.45 });
      }
    }
    // selection
    const sel = s.sel;
    if (!this.secondary) {
      for (const id of sel.wires) {
        const w = page.wires.find((x) => x.id === id);
        if (!w) continue;
        const st = wireStroke(this.styles, w);
        painter.stroke(new PathBuilder().poly(w.pts).build(), { color: accent, width: Math.max(st.width + px(3), px(3)), cap: "round", join: "round", alpha: 0.35 });
        // segment handles
        const hb = new PathBuilder();
        for (let i = 0; i < w.pts.length - 1; i++) {
          const a = w.pts[i], b = w.pts[i + 1];
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          hb.R(m.x - px(3), m.y - px(3), px(6), px(6));
        }
        painter.fill(hb.build(), "#ffffff");
        painter.stroke(hb.build(), { color: accent, width: px(1) });
        const eb = new PathBuilder();
        for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) eb.E(p.x, p.y, px(3.5), px(3.5));
        painter.fill(eb.build(), accent);
      }
      for (const id of sel.elements) {
        const e = page.elements.find((x) => x.id === id);
        const def = e && doc.defs[e.defId];
        if (!e || !def) continue;
        const r = inflate(elementBounds(e, def), px(3));
        painter.stroke(new PathBuilder().RR(r.x, r.y, r.w, r.h, px(2), px(2)).build(), { color: accent, width: px(1.5), dash: e.locked ? [px(3), px(2)] : null });
      }
      for (const id of sel.junctions) {
        const j = page.junctions.find((x) => x.id === id);
        if (j) painter.stroke(new PathBuilder().E(j.x, j.y, px(6), px(6)).build(), { color: accent, width: px(1.5) });
      }
      const selShapes = sel.shapes ?? [];
      for (const id of selShapes) {
        const sh = page.shapes.find((x) => x.id === id);
        if (!sh) continue;
        painter.stroke(new PathBuilder().poly(shapeOutline(sh)).build(), { color: accent, width: Math.max(sh.width + px(3), px(3)), cap: "round", join: "round", alpha: 0.35 });
        if (selShapes.length === 1 && this.editable) {
          const hb = new PathBuilder();
          for (const q of sh.pts) hb.R(q.x - px(3.5), q.y - px(3.5), px(7), px(7));
          painter.fill(hb.build(), "#ffffff");
          painter.stroke(hb.build(), { color: accent, width: px(1.25) });
        }
      }
      for (const id of sel.texts) {
        const it = this.indexed.get("t:" + id)?.items[0];
        if (it) painter.stroke(new PathBuilder().R(it.minX - px(2), it.minY - px(2), it.maxX - it.minX + px(4), it.maxY - it.minY + px(4)).build(), { color: accent, width: px(1), dash: [px(3), px(2)] });
      }
    }
    // hover
    const h = this.hover;
    if (h && this.mode.m === "idle") {
      if (h.k === "el" && !sel.elements.includes(h.id)) {
        const e = page.elements.find((x) => x.id === h.id);
        const def = e && doc.defs[e.defId];
        if (e && def) {
          const r = inflate(elementBounds(e, def), px(3));
          painter.stroke(new PathBuilder().RR(r.x, r.y, r.w, r.h, px(2), px(2)).build(), { color: accent, width: px(1), alpha: 0.5 });
        }
      } else if (h.k === "wire" && !sel.wires.includes(h.id)) {
        const w = page.wires.find((x) => x.id === h.id);
        if (w) painter.stroke(new PathBuilder().poly(w.pts).build(), { color: accent, width: px(3), cap: "round", join: "round", alpha: 0.25 });
      } else if (h.k === "shape" && !(sel.shapes ?? []).includes(h.id)) {
        const sh = page.shapes.find((x) => x.id === h.id);
        if (sh) painter.stroke(new PathBuilder().poly(shapeOutline(sh)).build(), { color: accent, width: px(3), cap: "round", join: "round", alpha: 0.25 });
      } else if (h.k === "pin" && this.editable) {
        painter.stroke(new PathBuilder().E(h.p.x, h.p.y, px(5), px(5)).build(), { color: "#16a34a", width: px(1.5) });
      } else if (h.k === "etext") {
        const it = this.indexed.get("e:" + h.el)?.items.find((i) => i.kind === "etext" && i.sub === h.text);
        if (it) painter.stroke(new PathBuilder().R(it.minX - px(1), it.minY - px(1), it.maxX - it.minX + px(2), it.maxY - it.minY + px(2)).build(), { color: accent, width: px(1), dash: [px(2), px(2)], alpha: 0.7 });
      }
    }
    // move guides
    const m = this.mode;
    if (m.m === "move") {
      const vr = this.worldViewport();
      const gp = new PathBuilder();
      if (m.guides.x !== undefined) gp.M(m.guides.x, vr.y).L(m.guides.x, vr.y + vr.h);
      if (m.guides.y !== undefined) gp.M(vr.x, m.guides.y).L(vr.x + vr.w, m.guides.y);
      painter.stroke(gp.build(), { color: "#ec4899", width: px(1), dash: [px(4), px(3)] });
      // connection preview on drop
      const pv = this.preview;
      if (pv) {
        const auto = findAutoConnections(pv, getPage(pv, s.pageId), m.sel.elements);
        const b = new PathBuilder();
        for (const a of auto) b.E(a.p.x, a.p.y, px(6), px(6));
        painter.stroke(b.build(), { color: "#16a34a", width: px(2) });
      }
    }
    // box
    if (m.m === "box") {
      const r = normRect(m.a, m.b);
      const crossing = m.b.x < m.a.x;
      const path = new PathBuilder().R(r.x, r.y, r.w, r.h).build();
      painter.fill(path, accent, 0.06);
      painter.stroke(path, { color: accent, width: px(1), dash: crossing ? [px(4), px(3)] : null });
    }
    // wire preview
    if (m.m === "wire") {
      const pts = this.wirePreview(m);
      painter.stroke(new PathBuilder().poly(pts).build(), { color: accent, width: Math.max(1, px(1.5)), cap: "round", join: "round" });
      const cb = new PathBuilder();
      for (const p of m.corners) cb.E(p.x, p.y, px(2.5), px(2.5));
      painter.fill(cb.build(), accent);
    }
    // shape being drawn: in its real style, plus accent handles and a size readout
    if (m.m === "draw") {
      const pv = this.drawPreviewPts(m);
      const st = s.shapeStyle;
      const b = new PathBuilder();
      if (pv.kind === "rect" || pv.kind === "ellipse") {
        const r = normRect(pv.pts[0], pv.pts[1]);
        if (pv.kind === "rect") b.R(r.x, r.y, r.w, r.h);
        else b.E(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2);
      } else b.poly(pv.closed ? [...pv.pts, pv.pts[0]] : pv.pts);
      const path = b.build();
      if (st.fill && (pv.kind !== "poly" || pv.closed)) painter.fill(path, st.fill, 0.6);
      painter.stroke(path, { color: st.color, width: st.width, dash: DASHES[st.dash] ?? null, minPx: 1 });
      painter.stroke(path, { color: accent, width: px(1), dash: [px(3), px(3)], alpha: 0.7 });
      const hb = new PathBuilder();
      for (const p of m.pts) hb.R(p.x - px(3), p.y - px(3), px(6), px(6));
      painter.fill(hb.build(), accent);
      const r = normRect(m.pts[m.pts.length - 1], m.cur);
      const txt = m.kind === "rect" || m.kind === "ellipse" ? `${Math.round(Math.abs(m.cur.x - m.pts[0].x))} × ${Math.round(Math.abs(m.cur.y - m.pts[0].y))}` : `${Math.round(Math.hypot(r.w, r.h))}`;
      const sp = this.toScreen(m.cur);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.font = "500 11px ui-sans-serif, -apple-system, sans-serif";
      const w = c.measureText(txt).width + 10;
      c.fillStyle = accent;
      roundRect(c, sp.x + 12, sp.y + 10, w, 18, 4);
      c.fill();
      c.fillStyle = "#fff";
      c.textBaseline = "middle";
      c.fillText(txt, sp.x + 17, sp.y + 19);
      c.setTransform(...base);
    }
    // placement ghost
    if (this.placeGhost && s.tool === "place") {
      drawElement(painter, this.placeGhost.e, this.placeGhost.def, this.styles, { lod: sc, alpha: 0.55, tint: accent, pins: true, measure: measureText });
    }
    // snap indicator
    const sn = this.snapInd;
    if (sn && (m.m === "wire" || m.m === "end" || m.m === "spt" || m.m === "draw" || s.tool === "wire" || s.tool === "shape") && sn.kind !== "grid" && sn.kind !== "none") {
      const col = sn.kind === "pin" ? "#16a34a" : sn.kind === "junction" || sn.kind === "wireEnd" ? "#0891b2" : sn.kind === "wire" ? "#d97706" : "#ec4899";
      const b = new PathBuilder();
      if (sn.kind === "pin") b.E(sn.p.x, sn.p.y, px(6), px(6));
      else if (sn.kind === "wire") b.R(sn.p.x - px(5), sn.p.y - px(5), px(10), px(10));
      else if (sn.kind === "guide") {
        const vr = this.worldViewport();
        if (sn.guideX !== undefined) b.M(sn.guideX, vr.y).L(sn.guideX, vr.y + vr.h);
        if (sn.guideY !== undefined) b.M(vr.x, sn.guideY).L(vr.x + vr.w, sn.guideY);
      } else b.E(sn.p.x, sn.p.y, px(5), px(5));
      painter.stroke(b.build(), { color: col, width: px(1.75), dash: sn.kind === "guide" ? [px(4), px(3)] : null });
      if (sn.createsJunction) painter.fill(new PathBuilder().E(sn.p.x, sn.p.y, px(3), px(3)).build(), col);
      if (sn.label) {
        const txt = sn.label;
        const p = this.toScreen(sn.p);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.font = "500 11px ui-sans-serif, -apple-system, sans-serif";
        const w = c.measureText(txt).width + 10;
        c.fillStyle = col;
        roundRect(c, p.x + 10, p.y + 8, w, 18, 4);
        c.fill();
        c.fillStyle = "#fff";
        c.textBaseline = "middle";
        c.fillText(txt, p.x + 15, p.y + 17);
      }
    }
    // linked label hover + arrival flash
    const hl = this.hoverLink;
    if (hl && hl.pageId === page.id && this.mode.m === "idle") {
      const r = hl.rect;
      const ub = new PathBuilder().M(r.x, r.y + r.h + px(1)).L(r.x + r.w, r.y + r.h + px(1)).build();
      painter.stroke(ub, { color: accent, width: px(1.25), dash: this.hoverMod ? null : [px(2), px(2)] });
      const tg = targetsOf(this.xref(), hl);
      if (tg.length) {
        const sp = this.toScreen({ x: r.x, y: r.y + r.h });
        const key = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
        const txt = `${this.hoverMod ? "Click" : `${key}-click`} → ${describe(this.s.doc, tg[0])}${tg.length > 1 ? `  (+${tg.length - 1} more)` : ""}`;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.font = "500 11px ui-sans-serif, -apple-system, sans-serif";
        const w = c.measureText(txt).width + 12;
        c.fillStyle = "rgba(24,24,27,0.92)";
        roundRect(c, sp.x, sp.y + 6, w, 20, 5);
        c.fill();
        c.fillStyle = "#fff";
        c.textBaseline = "middle";
        c.fillText(txt, sp.x + 6, sp.y + 16);
        c.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
      }
    }
    const fl = this.flash;
    if (fl && fl.pageId === page.id) {
      const left = fl.until - performance.now();
      if (left > 0) {
        const a = Math.min(1, left / 600);
        const r = inflate(fl.rect, px(4));
        const path = new PathBuilder().RR(r.x, r.y, r.w, r.h, px(3), px(3)).build();
        painter.fill(path, "#f59e0b", 0.25 * a);
        painter.stroke(path, { color: "#f59e0b", width: px(2), alpha: a });
      } else this.flash = null;
    }
    // comment pins (screen space)
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const cm of s.comments) {
      if (!cm.anchor || cm.pageId !== page.id) continue;
      const p = this.toScreen(cm.anchor);
      const active = s.activeComment === cm.id;
      c.fillStyle = cm.status === "RESOLVED" ? "#9ca3af" : active ? "#7c3aed" : "#9333ea";
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.arc(p.x + 9, p.y - 9, 9, Math.PI * 0.75, Math.PI * 2.25);
      c.closePath();
      c.fill();
      if (active) {
        c.strokeStyle = "#fff";
        c.lineWidth = 2;
        c.stroke();
      }
      c.fillStyle = "#fff";
      c.font = "600 10px ui-sans-serif, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(cm.replies + 1), p.x + 9, p.y - 9);
      c.textAlign = "left";
    }
  }

  /** Render the current page offscreen at small scale (minimap). */
  renderThumbnail(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx || !this.s.doc) return null;
    const doc = this.s.doc;
    const page = this.s.page();
    const r = contentBounds(doc, page, true);
    const s = Math.min(canvas.width / r.w, canvas.height / r.h);
    const ox = (canvas.width - r.w * s) / 2 - r.x * s, oy = (canvas.height - r.h * s) / 2 - r.y * s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(r.x * s + ox, r.y * s + oy, r.w * s, r.h * s);
    const p = new CanvasPainter(ctx, [s, 0, 0, s, ox, oy], 1);
    drawPage(p, { doc, page, lod: s * 0.6, editor: { pins: false, dangling: false } });
    return { s, ox, oy };
  }

  get size() {
    return { w: this.w, h: this.h };
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}
export function isTyping(e: KeyboardEvent) {
  return isTypingTarget(e.target);
}
function isTrackpadPan(e: WheelEvent) {
  // trackpads send fractional / small, frequent deltas with deltaX; mouse wheels send line-ish steps
  return e.deltaMode === 0 && (Math.abs(e.deltaX) > 0 || (Math.abs(e.deltaY) < 50 && !Number.isInteger(e.deltaY)));
}

export type { Hit };
export type RoleT = TextRole;
