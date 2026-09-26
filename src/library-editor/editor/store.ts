"use client";
import { create } from "zustand";
import { produce, type Draft } from "immer";
import type { ElementDef, Orient, PinDef, Prim } from "@/core/model";
import { effectiveFrame, newUuid, type Frame } from "@/lib/library/elmt-tools";

export type EdPrim = Prim & { id: string };
export type EdDoc = {
  prims: EdPrim[];
  pins: PinDef[];
  names: Record<string, string>;
  linkType: string;
  info: Record<string, string>;
  kind: Record<string, string>;
  informations: string;
};

export type MetaForm = {
  category: string;
  prefix: string;
  description: string;
  tags: string[];
  manufacturer: string;
  partNumber: string;
  function: string;
  license: string;
  attribution: string;
  source: string;
  extra: Record<string, string>;
};

export type ToolId = "select" | "line" | "rect" | "ellipse" | "arc" | "polygon" | "text" | "dyntext" | "pin";

export type ToolOpts = {
  polyClosed: boolean;
  dynSource: string; // info key or "__user"
  pinOrient: Orient | null; // null = auto
  pinType: string;
};

let pid = 0;
export const primId = () => `p${++pid}_${Math.random().toString(36).slice(2, 7)}`;
export const withId = (p: Prim): EdPrim => ({ ...p, id: primId() }) as EdPrim;
export const stripId = (p: EdPrim): Prim => {
  const { id: _id, ...rest } = p;
  void _id;
  return rest as Prim;
};

export function docFromDef(def: ElementDef): EdDoc {
  return {
    prims: def.prims.map(withId),
    pins: def.pins.map((p) => ({ ...p })),
    names: { ...def.names, en: def.names.en ?? def.name },
    linkType: def.linkType || "simple",
    info: { ...def.info },
    kind: { ...def.kind },
    informations: def.meta.informations ?? "",
  };
}

type HistoryEntry = { doc: EdDoc; sel: string[] };

export type EdState = {
  doc: EdDoc;
  past: HistoryEntry[];
  future: HistoryEntry[];
  savedDoc: EdDoc;
  meta: MetaForm;
  savedMeta: MetaForm;
  sel: string[];
  hover: string | null;
  tool: ToolId;
  toolOpts: ToolOpts;
  grid: number;
  snap: boolean;
  showGrid: boolean;
  zoomPct: number;
  cursor: { x: number; y: number } | null;
  lastKey: string | null;
  lastAt: number;
  gestureBase: EdDoc | null;
  /** bump to request a canvas redraw from outside */
  tick: number;
  /** frame (size/hotspot) of the stored definition */
  baseFrame: Frame | null;
  load(doc: EdDoc, meta: MetaForm, frame?: Frame | null): void;
  markSaved(): void;
  /** commit a change (coalesces rapid edits with the same key) */
  change(recipe: (d: Draft<EdDoc>) => void, key?: string): void;
  begin(): void;
  live(recipe: (d: Draft<EdDoc>) => void): void;
  end(): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  setSel(ids: string[]): void;
  setHover(id: string | null): void;
  setTool(t: ToolId): void;
  setToolOpts(o: Partial<ToolOpts>): void;
  setMeta(m: Partial<MetaForm>): void;
  set(p: Partial<Pick<EdState, "grid" | "snap" | "showGrid" | "zoomPct" | "cursor">>): void;
};

const LIMIT = 200;
const emptyMeta = (): MetaForm => ({ category: "", prefix: "", description: "", tags: [], manufacturer: "", partNumber: "", function: "", license: "", attribution: "", source: "", extra: {} });
const emptyDoc = (): EdDoc => ({ prims: [], pins: [], names: { en: "" }, linkType: "simple", info: {}, kind: {}, informations: "" });

function readGrid(): number {
  try {
    const v = Number(localStorage.getItem("volt.symed.grid"));
    return [1, 2, 5, 10].includes(v) ? v : 5;
  } catch {
    return 5;
  }
}

export const useEd = create<EdState>((set, get) => ({
  doc: emptyDoc(),
  past: [],
  future: [],
  savedDoc: emptyDoc(),
  meta: emptyMeta(),
  savedMeta: emptyMeta(),
  sel: [],
  hover: null,
  tool: "select",
  toolOpts: { polyClosed: false, dynSource: "label", pinOrient: null, pinType: "Generic" },
  grid: 5,
  snap: true,
  showGrid: true,
  zoomPct: 100,
  cursor: null,
  lastKey: null,
  lastAt: 0,
  gestureBase: null,
  tick: 0,
  baseFrame: null,
  load(doc, meta, frame) {
    set({ baseFrame: frame ?? null, doc, savedDoc: doc, meta, savedMeta: meta, past: [], future: [], sel: [], hover: null, gestureBase: null, lastKey: null, grid: readGrid(), tick: get().tick + 1 });
  },
  markSaved() {
    set({ savedDoc: get().doc, savedMeta: get().meta });
  },
  change(recipe, key) {
    const s = get();
    const next = produce(s.doc, recipe);
    if (next === s.doc) return;
    const now = Date.now();
    const coalesce = key && key === s.lastKey && now - s.lastAt < 1000;
    set({
      doc: next,
      past: coalesce ? s.past : [...s.past, { doc: s.doc, sel: s.sel }].slice(-LIMIT),
      future: [],
      lastKey: key ?? null,
      lastAt: now,
      sel: s.sel.filter((id) => next.prims.some((p) => p.id === id) || next.pins.some((p) => p.id === id)),
    });
  },
  begin() {
    set({ gestureBase: get().doc });
  },
  live(recipe) {
    set({ doc: produce(get().doc, recipe) });
  },
  end() {
    const s = get();
    if (!s.gestureBase) return;
    if (s.gestureBase !== s.doc) set({ past: [...s.past, { doc: s.gestureBase, sel: s.sel }].slice(-LIMIT), future: [], lastKey: null });
    set({ gestureBase: null });
  },
  cancelGesture() {
    const s = get();
    if (s.gestureBase) set({ doc: s.gestureBase, gestureBase: null });
  },
  undo() {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({ doc: prev.doc, sel: prev.sel, past: s.past.slice(0, -1), future: [{ doc: s.doc, sel: s.sel }, ...s.future].slice(0, LIMIT), lastKey: null });
  },
  redo() {
    const s = get();
    const nx = s.future[0];
    if (!nx) return;
    set({ doc: nx.doc, sel: nx.sel, future: s.future.slice(1), past: [...s.past, { doc: s.doc, sel: s.sel }], lastKey: null });
  },
  setSel(ids) {
    set({ sel: ids });
  },
  setHover(id) {
    if (get().hover !== id) set({ hover: id });
  },
  setTool(t) {
    set({ tool: t, hover: null });
  },
  setToolOpts(o) {
    set({ toolOpts: { ...get().toolOpts, ...o } });
  },
  setMeta(m) {
    set({ meta: { ...get().meta, ...m } });
  },
  set(p) {
    if (p.grid) {
      try {
        localStorage.setItem("volt.symed.grid", String(p.grid));
      } catch {}
    }
    set(p);
  },
}));

export function isDirty(s: Pick<EdState, "doc" | "savedDoc" | "meta" | "savedMeta">): boolean {
  return s.doc !== s.savedDoc || JSON.stringify(s.meta) !== JSON.stringify(s.savedMeta);
}

/** ElementDef view of the editor document (memoised per doc identity). */
const defCache = new WeakMap<EdDoc, ElementDef>();
export function defOf(doc: EdDoc, base?: Partial<ElementDef>): ElementDef {
  if (!base) {
    const c = defCache.get(doc);
    if (c) return c;
  }
  const f = effectiveFrame({ prims: doc.prims, pins: doc.pins }, useEd.getState().baseFrame);
  const def: ElementDef = {
    id: "editing",
    uuid: base?.uuid ?? "",
    name: doc.names.en || "element",
    names: doc.names,
    ...f,
    linkType: doc.linkType,
    prefix: base?.prefix ?? "",
    category: base?.category ?? "",
    prims: doc.prims as Prim[],
    pins: doc.pins,
    info: doc.info,
    kind: doc.kind,
    meta: { ...(base?.meta ?? {}), informations: doc.informations },
    xml: base?.xml,
  };
  if (!base) defCache.set(doc, def);
  return def;
}

export const newPinId = () => newUuid();
