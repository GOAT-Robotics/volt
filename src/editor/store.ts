"use client";
import { create } from "zustand";
import { enablePatches, produce, setAutoFreeze } from "immer";
import { applyOps, diffOps, type LiveOp } from "@/core/live-ops";
import type { LiveState, Peer } from "./live/types";
import type { Doc, Page, PartialStyles, Pt } from "@/core/model";
import { emptySel, ensureInstanceTexts, type Sel } from "@/core/ops";
import type { DocDiff } from "@/core/diff";

enablePatches();
setAutoFreeze(false);

export type Tool = "select" | "wire" | "text" | "pan" | "comment" | "place" | "shape";
/** what the shape tool draws */
export type DrawKind = "rect" | "ellipse" | "line" | "polygon" | "polyline";
export type DrawStyle = { color: string; width: number; dash: "solid" | "dashed" | "dotted" | "dashdot"; fill: string | null };

/** One undo step: id-addressed operations (stay valid when others edit at the same time). */
export type HistoryEntry = { label: string; ops: LiveOp[]; inverse: LiveOp[]; pageId: string; sel: Sel; at: number };

/** Where local changes go when a live session is connected (set by the live client). */
let liveSink: ((ops: LiveOp[]) => void) | null = null;
export const setLiveSink = (fn: ((ops: LiveOp[]) => void) | null) => void (liveSink = fn);

export type VersionInfo = {
  projectId: string;
  projectName: string;
  versionId: string;
  label: string;
  status: string;
  docRev: number;
  editable: boolean;
  reason?: string; // why read-only
  canComment: boolean;
  canExport: boolean;
  userId: string;
  userName: string;
};

export type CommentPin = {
  id: string;
  pageId: string | null;
  anchor: { type: string; id?: string; x: number; y: number } | null;
  status: string;
  body: string;
  author: string;
  createdAt: string;
  replies: number;
};

export type PlaceSpec = { kind: "element"; defId: string; rot: 0 | 1 | 2 | 3; mirror: boolean } | { kind: "block"; blockId: string; name: string };

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict" | "readonly";

type State = {
  doc: Doc;
  pageId: string;
  sel: Sel;
  tool: Tool;
  place: PlaceSpec | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  version: VersionInfo | null;
  save: SaveState;
  saveError: string | null;
  lastSavedAt: number | null;
  /** transient style preview (global style dialog) — rendered but not committed */
  previewStyles: PartialStyles | null;
  diff: { doc: Doc; diff: DocDiff; label: string; mode: "overlay" | "side" } | null;
  comments: CommentPin[];
  activeComment: string | null;
  /** comment being composed (set by the canvas comment tool, consumed by the review panel) */
  pendingComment: { pageId: string; anchor: { type: string; id?: string; x: number; y: number } | null } | null;
  highlight: Set<string> | null; // net highlight / search locate
  cursor: Pt | null;
  zoom: number;
  panels: { left: "library" | "pages" | "outline" | null; right: "inspector" | "review" | "validate" | "history" | null };
  snapSettings: { pins: boolean; junctions: boolean; wires: boolean; guides: boolean; grid: boolean; order: ("pin" | "junction" | "wire" | "guide" | "grid")[] };
  gridVisible: boolean;
  /** shape tool: kind to draw and the style new shapes get (last used) */
  shapeKind: DrawKind;
  shapeStyle: DrawStyle;
  /** live collaboration */
  live: LiveState;
  peers: Record<string, Peer>;
  /** clientId of the person whose view this one follows (Figma-style observation) */
  following: string | null;
  /** view only, even with edit rights */
  spectator: boolean;
  /** local drag in progress (shown to others) */
  drag: { sel: Sel; dx: number; dy: number } | null;
};

type Actions = {
  init(doc: Doc, version: VersionInfo | null): void;
  setDoc(doc: Doc): void;
  apply(label: string, fn: (d: Doc) => void, opts?: { sel?: Sel; keepFuture?: boolean }): boolean;
  undo(): void;
  redo(): void;
  setPage(id: string): void;
  setSel(s: Sel): void;
  clearSel(): void;
  setTool(t: Tool, place?: PlaceSpec | null): void;
  setSave(s: SaveState, err?: string | null): void;
  markSaved(rev: number): void;
  page(): Page;
  set<K extends keyof State>(k: K, v: State[K]): void;
  /** changes from someone else in the live session (not in the undo history) */
  applyRemote(ops: LiveOp[]): void;
  /** the live session's current document (server state + my unconfirmed changes) */
  setLiveDoc(doc: Doc): void;
  /** the live session's document replaces the local one */
  replaceDoc(doc: Doc, rev: number): void;
};

export type EditorStore = State & Actions;

const HISTORY_LIMIT = 300;

export const useEditor = create<EditorStore>((set, get) => ({
  doc: null as unknown as Doc,
  pageId: "",
  sel: emptySel(),
  tool: "select",
  place: null,
  past: [],
  future: [],
  version: null,
  save: "saved",
  saveError: null,
  lastSavedAt: null,
  previewStyles: null,
  diff: null,
  comments: [],
  activeComment: null,
  pendingComment: null,
  highlight: null,
  cursor: null,
  zoom: 1,
  panels: { left: "library", right: "inspector" },
  snapSettings: { pins: true, junctions: true, wires: true, guides: true, grid: true, order: ["pin", "junction", "wire", "guide", "grid"] },
  gridVisible: true,
  shapeKind: "rect",
  shapeStyle: { color: "#111827", width: 1, dash: "solid", fill: null },
  live: { status: "off", clientId: null, color: null },
  peers: {},
  following: null,
  spectator: false,
  drag: null,

  init(doc, version) {
    // every reference gets its own movable / rotatable text (legacy & imported instances too)
    for (const p of doc.pages) for (const e of p.elements) if (doc.defs[e.defId] && !doc.defs[e.defId].placeholder) ensureInstanceTexts(doc.defs[e.defId], e);
    const first = [...doc.pages].sort((a, b) => a.order - b.order)[0];
    set({
      doc,
      version,
      pageId: first?.id ?? "",
      sel: emptySel(),
      past: [],
      future: [],
      save: version && !version.editable ? "readonly" : "saved",
      tool: "select",
      place: null,
      diff: null,
      highlight: null,
    });
  },
  setDoc(doc) {
    set({ doc });
  },
  apply(label, fn, opts) {
    const s = get();
    if ((s.version && !s.version.editable) || s.spectator) return false;
    // callers often write `(d) => (d.x = v)`; the arrow's value must not reach Immer as a replacement
    const next = produce(s.doc, (d: Doc) => {
      fn(d);
    });
    if (next === s.doc) return false;
    const ops = diffOps(s.doc, next);
    if (!ops.length) return false;
    const entry: HistoryEntry = { label, ops, inverse: diffOps(next, s.doc), pageId: s.pageId, sel: s.sel, at: Date.now() };
    const past = [...s.past, entry];
    if (past.length > HISTORY_LIMIT) past.shift();
    set({ doc: next, past, future: opts?.keepFuture ? s.future : [], save: "dirty", ...(opts?.sel ? { sel: opts.sel } : {}) });
    liveSink?.(ops);
    return true;
  },
  undo() {
    const s = get();
    const e = s.past[s.past.length - 1];
    if (!e || s.spectator) return;
    // operations by id: still correct after other people's edits (theirs are kept)
    const doc = produce(s.doc, (d: Doc) => applyOps(d, e.inverse));
    const pageExists = doc.pages.some((p) => p.id === e.pageId);
    set({ doc, past: s.past.slice(0, -1), future: [e, ...s.future], sel: e.sel, pageId: pageExists ? e.pageId : s.pageId, save: "dirty" });
    const ops = diffOps(s.doc, doc);
    if (ops.length) liveSink?.(ops);
  },
  redo() {
    const s = get();
    const e = s.future[0];
    if (!e || s.spectator) return;
    const doc = produce(s.doc, (d: Doc) => applyOps(d, e.ops));
    set({ doc, past: [...s.past, e], future: s.future.slice(1), save: "dirty", pageId: doc.pages.some((p) => p.id === e.pageId) ? e.pageId : s.pageId });
    const ops = diffOps(s.doc, doc);
    if (ops.length) liveSink?.(ops);
  },
  applyRemote(ops) {
    const s = get();
    if (!ops.length) return;
    get().setLiveDoc(produce(s.doc, (d: Doc) => applyOps(d, ops)));
  },
  setLiveDoc(doc) {
    const s = get();
    if (doc === s.doc) return;
    // keep the selection to what still exists
    const page = doc.pages.find((p) => p.id === s.pageId);
    const keep = (ids: string[], list: { id: string }[] | undefined) => (list ? ids.filter((id) => list.some((x) => x.id === id)) : []);
    const sel = page
      ? { elements: keep(s.sel.elements, page.elements), wires: keep(s.sel.wires, page.wires), junctions: keep(s.sel.junctions, page.junctions), texts: keep(s.sel.texts, page.texts), shapes: keep(s.sel.shapes ?? [], page.shapes) }
      : emptySel();
    const same = sel.elements.length === s.sel.elements.length && sel.wires.length === s.sel.wires.length && sel.junctions.length === s.sel.junctions.length && sel.texts.length === s.sel.texts.length && sel.shapes.length === (s.sel.shapes ?? []).length;
    set({ doc, ...(same ? {} : { sel }), ...(page ? {} : { pageId: [...doc.pages].sort((a, b) => a.order - b.order)[0]?.id ?? s.pageId }) });
  },
  replaceDoc(doc, rev) {
    const s = get();
    const page = doc.pages.some((p) => p.id === s.pageId) ? s.pageId : [...doc.pages].sort((a, b) => a.order - b.order)[0]?.id ?? "";
    set({ doc, pageId: page, version: s.version ? { ...s.version, docRev: rev } : s.version, ...(page === s.pageId ? {} : { sel: emptySel() }) });
  },
  setPage(id) {
    set({ pageId: id, sel: emptySel(), highlight: null });
  },
  setSel(sel) {
    set({ sel });
  },
  clearSel() {
    set({ sel: emptySel() });
  },
  setTool(tool, place = null) {
    set({ tool, place: tool === "place" ? place : null });
  },
  setSave(save, err = null) {
    set({ save, saveError: err });
  },
  markSaved(rev) {
    const v = get().version;
    set({ save: "saved", lastSavedAt: Date.now(), saveError: null, version: v ? { ...v, docRev: rev } : v });
  },
  page() {
    const s = get();
    return s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.pages[0];
  },
  set(k, v) {
    set({ [k]: v } as Partial<State>);
  },
}));

export const selectPage = (s: EditorStore) => s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.pages[0];
