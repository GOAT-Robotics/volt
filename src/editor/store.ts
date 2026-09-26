"use client";
import { create } from "zustand";
import { applyPatches, enablePatches, produceWithPatches, setAutoFreeze, type Patch } from "immer";
import type { Doc, Page, PartialStyles, Pt } from "@/core/model";
import { emptySel, type Sel } from "@/core/ops";
import type { DocDiff } from "@/core/diff";

enablePatches();
setAutoFreeze(false);

export type Tool = "select" | "wire" | "text" | "pan" | "comment" | "place";

export type HistoryEntry = { label: string; patches: Patch[]; inverse: Patch[]; pageId: string; sel: Sel; at: number };

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

  init(doc, version) {
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
    if (s.version && !s.version.editable) return false;
    const [next, patches, inverse] = produceWithPatches(s.doc, fn);
    if (!patches.length) return false;
    const entry: HistoryEntry = { label, patches, inverse, pageId: s.pageId, sel: s.sel, at: Date.now() };
    const past = [...s.past, entry];
    if (past.length > HISTORY_LIMIT) past.shift();
    set({ doc: next, past, future: opts?.keepFuture ? s.future : [], save: "dirty", ...(opts?.sel ? { sel: opts.sel } : {}) });
    return true;
  },
  undo() {
    const s = get();
    const e = s.past[s.past.length - 1];
    if (!e) return;
    const doc = applyPatches(s.doc, e.inverse);
    const pageExists = doc.pages.some((p) => p.id === e.pageId);
    set({ doc, past: s.past.slice(0, -1), future: [e, ...s.future], sel: e.sel, pageId: pageExists ? e.pageId : s.pageId, save: "dirty" });
  },
  redo() {
    const s = get();
    const e = s.future[0];
    if (!e) return;
    const doc = applyPatches(s.doc, e.patches);
    set({ doc, past: [...s.past, e], future: s.future.slice(1), save: "dirty", pageId: doc.pages.some((p) => p.id === e.pageId) ? e.pageId : s.pageId });
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
