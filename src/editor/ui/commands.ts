"use client";
import { useEditor, type EditorStore } from "../store";
import type { EditorUI } from "./context";
import {
  copySelection,
  deleteSelection,
  emptySel,
  getPage,
  mirrorSelection,
  moveSelection,
  pasteClip,
  rotateSelection,
  selSize,
  type Clip,
} from "@/core/ops";
import { newPage } from "@/core/doc";
import { convertShapesToWires, isOpenPath } from "@/core/shapes";
import { uid } from "@/core/ids";

export type Command = {
  id: string;
  label: string;
  section: "Edit" | "View" | "Tools" | "Arrange" | "Page" | "Project" | "Review" | "Help";
  keys?: string; // display
  enabled?: (s: EditorStore) => boolean;
  run: (ui: EditorUI, s: EditorStore) => void | Promise<void>;
};

let clipboard: Clip | null = null;
const editable = (s: EditorStore) => !s.version || s.version.editable;
const hasSel = (s: EditorStore) => selSize(s.sel) > 0;
const hasEls = (s: EditorStore) => s.sel.elements.length > 0;
const hasShapes = (s: EditorStore) => (s.sel.shapes?.length ?? 0) > 0;
const selLines = (s: EditorStore) => s.page().shapes.filter((x) => s.sel.shapes?.includes(x.id) && isOpenPath(x));

function convertLines(ui: EditorUI, s: EditorStore, ids: string[]) {
  if (!ids.length) return ui.toast("No drawn lines to convert");
  let r: ReturnType<typeof convertShapesToWires> | null = null;
  s.apply("Convert lines to wires", (d) => void (r = convertShapesToWires(d, getPage(d, s.pageId), ids)));
  const res = r as ReturnType<typeof convertShapesToWires> | null;
  if (!res) return;
  s.setSel({ ...emptySel(), wires: res.wires });
  ui.toast(`Converted ${res.converted} line${res.converted === 1 ? "" : "s"} into ${res.wires.length} wire${res.wires.length === 1 ? "" : "s"}${res.pinEnds ? ` · ${res.pinEnds} end${res.pinEnds === 1 ? "" : "s"} connected to pins` : ""}`);
}

export const COMMANDS: Command[] = [
  { id: "undo", label: "Undo", section: "Edit", keys: "⌘Z", enabled: (s) => editable(s) && s.past.length > 0, run: (_, s) => s.undo() },
  { id: "redo", label: "Redo", section: "Edit", keys: "⇧⌘Z", enabled: (s) => editable(s) && s.future.length > 0, run: (_, s) => s.redo() },
  {
    id: "copy",
    label: "Copy",
    section: "Edit",
    keys: "⌘C",
    enabled: hasSel,
    run: (ui, s) => {
      clipboard = copySelection(s.doc, s.page(), s.sel);
      try {
        navigator.clipboard?.writeText(JSON.stringify({ volt: 1, clip: clipboard })).catch(() => {});
      } catch {}
      ui.toast(`Copied ${selSize(s.sel)} object${selSize(s.sel) > 1 ? "s" : ""}`);
    },
  },
  {
    id: "cut",
    label: "Cut",
    section: "Edit",
    keys: "⌘X",
    enabled: (s) => editable(s) && hasSel(s),
    run: (ui, s) => {
      clipboard = copySelection(s.doc, s.page(), s.sel);
      const sel = s.sel;
      s.apply("Cut", (d) => deleteSelection(d, getPage(d, s.pageId), sel), { sel: emptySel() });
    },
  },
  {
    id: "paste",
    label: "Paste",
    section: "Edit",
    keys: "⌘V",
    enabled: (s) => editable(s),
    run: async (ui, s) => {
      let clip = clipboard;
      if (!clip) {
        try {
          const t = await navigator.clipboard?.readText();
          const j = t ? JSON.parse(t) : null;
          if (j?.volt === 1) clip = j.clip;
        } catch {}
      }
      if (!clip) return ui.toast("Clipboard is empty");
      const c = clip;
      const at = ui.engine.current?.contextPoint;
      let off = { x: 20, y: 20 };
      if (at && c.elements[0]) off = { x: Math.round((at.x - c.elements[0].x) / 10) * 10, y: Math.round((at.y - c.elements[0].y) / 10) * 10 };
      let sel = emptySel();
      s.apply("Paste", (d) => {
        sel = pasteClip(d, getPage(d, s.pageId), c, off);
      });
      useEditor.getState().setSel(sel);
    },
  },
  {
    id: "duplicate",
    label: "Duplicate",
    section: "Edit",
    keys: "⌘D",
    enabled: (s) => editable(s) && hasSel(s),
    run: (_, s) => {
      const clip = copySelection(s.doc, s.page(), s.sel);
      let sel = emptySel();
      s.apply("Duplicate", (d) => {
        sel = pasteClip(d, getPage(d, s.pageId), clip, { x: 20, y: 20 });
      });
      useEditor.getState().setSel(sel);
    },
  },
  {
    id: "delete",
    label: "Delete",
    section: "Edit",
    keys: "Del",
    enabled: (s) => editable(s) && hasSel(s),
    run: (ui, s) => {
      const sel = s.sel;
      const n = selSize(sel);
      s.apply("Delete", (d) => deleteSelection(d, getPage(d, s.pageId), sel), { sel: emptySel() });
      ui.announce(`Deleted ${n} object${n > 1 ? "s" : ""}`);
    },
  },
  {
    id: "selectAll",
    label: "Select all",
    section: "Edit",
    keys: "⌘A",
    run: (_, s) => {
      const p = s.page();
      s.setSel({ elements: p.elements.map((e) => e.id), wires: p.wires.map((w) => w.id), junctions: p.junctions.map((j) => j.id), texts: p.texts.map((t) => t.id), shapes: p.shapes.map((x) => x.id) });
    },
  },
  { id: "selectNet", label: "Select connected net", section: "Edit", keys: "N", enabled: hasSel, run: (ui) => ui.engine.current?.selectNet() },
  {
    id: "selectSame",
    label: "Select all instances of this element",
    section: "Edit",
    enabled: (s) => s.sel.elements.length === 1,
    run: (_, s) => {
      const e = s.page().elements.find((x) => x.id === s.sel.elements[0]);
      if (!e) return;
      s.setSel({ ...emptySel(), elements: s.page().elements.filter((x) => x.defId === e.defId).map((x) => x.id) });
    },
  },
  {
    id: "lock",
    label: "Lock / unlock",
    section: "Arrange",
    keys: "⌘L",
    enabled: (s) => editable(s) && hasEls(s),
    run: (_, s) => {
      const ids = new Set(s.sel.elements);
      const anyUnlocked = s.page().elements.some((e) => ids.has(e.id) && !e.locked);
      s.apply(anyUnlocked ? "Lock" : "Unlock", (d) => getPage(d, s.pageId).elements.forEach((e) => ids.has(e.id) && (e.locked = anyUnlocked)));
    },
  },
  {
    id: "hide",
    label: "Hide selected",
    section: "Arrange",
    enabled: (s) => editable(s) && hasEls(s),
    run: (_, s) => {
      const ids = new Set(s.sel.elements);
      s.apply("Hide", (d) => getPage(d, s.pageId).elements.forEach((e) => ids.has(e.id) && (e.hidden = true)), { sel: emptySel() });
    },
  },
  {
    id: "showAll",
    label: "Show hidden elements",
    section: "Arrange",
    enabled: (s) => editable(s) && s.page().elements.some((e) => e.hidden),
    run: (_, s) => void s.apply("Show all", (d) => getPage(d, s.pageId).elements.forEach((e) => (e.hidden = false))),
  },
  { id: "rotate", label: "Rotate 90° clockwise", section: "Arrange", keys: "R", enabled: (s) => editable(s) && (hasEls(s) || hasShapes(s) || s.tool === "place"), run: (ui, s) => void (ui.engine.current?.rotatePlacement() || s.apply("Rotate", (d) => rotateSelection(d, getPage(d, s.pageId), s.sel, true))) },
  { id: "rotateCcw", label: "Rotate 90° counter-clockwise", section: "Arrange", keys: "⇧R", enabled: (s) => editable(s) && (hasEls(s) || hasShapes(s)), run: (_, s) => void s.apply("Rotate", (d) => rotateSelection(d, getPage(d, s.pageId), s.sel, false)) },
  { id: "mirror", label: "Mirror", section: "Arrange", keys: "X", enabled: (s) => editable(s) && (hasEls(s) || hasShapes(s) || s.tool === "place"), run: (ui, s) => void (ui.engine.current?.mirrorPlacement() || s.apply("Mirror", (d) => mirrorSelection(d, getPage(d, s.pageId), s.sel))) },
  ...(["left", "center", "right", "top", "middle", "bottom"] as const).map(
    (a): Command => ({
      id: "align-" + a,
      label: `Align ${a}`,
      section: "Arrange",
      enabled: (s) => editable(s) && s.sel.elements.length > 1,
      run: (_, s) => void s.apply(`Align ${a}`, (d) => alignSel(d, s, a)),
    }),
  ),
  { id: "distH", label: "Distribute horizontally", section: "Arrange", enabled: (s) => editable(s) && s.sel.elements.length > 2, run: (_, s) => void s.apply("Distribute", (d) => distribute(d, s, "x")) },
  { id: "distV", label: "Distribute vertically", section: "Arrange", enabled: (s) => editable(s) && s.sel.elements.length > 2, run: (_, s) => void s.apply("Distribute", (d) => distribute(d, s, "y")) },
  {
    id: "resetText",
    label: "Restore default label placement",
    section: "Arrange",
    enabled: (s) => editable(s) && hasEls(s),
    run: (_, s) => {
      const ids = new Set(s.sel.elements);
      s.apply("Restore label placement", (d) =>
        getPage(d, s.pageId).elements.forEach((e) => {
          if (!ids.has(e.id)) return;
          const def = d.defs[e.defId];
          for (const t of e.texts) {
            const dp = def?.prims.find((p) => p.t === "dyntext" && ((t.uuid && p.uuid === t.uuid) || (p.info === t.info && t.info)));
            if (dp && dp.t === "dyntext") (t.x = dp.x), (t.y = dp.y);
            else (t.x = null), (t.y = null);
          }
        }),
      );
    },
  },
  {
    id: "resetOverrides",
    label: "Reset style overrides on selection",
    section: "Arrange",
    enabled: (s) => editable(s) && hasSel(s),
    run: (ui, s) => {
      const sel = s.sel;
      let n = 0;
      s.apply("Reset overrides", (d) => {
        const p = getPage(d, s.pageId);
        for (const e of p.elements)
          if (sel.elements.includes(e.id)) {
            for (const t of e.texts) if (t.override) (t.override = undefined), n++;
            if (e.outlineOverride) (e.outlineOverride = undefined), n++;
          }
        for (const w of p.wires) if (sel.wires.includes(w.id) && w.override) (w.override = undefined), n++;
        for (const t of p.texts) if (sel.texts.includes(t.id) && t.override) (t.override = undefined), n++;
      });
      ui.toast(n ? `Reset ${n} override${n > 1 ? "s" : ""}` : "No overrides on the selection");
    },
  },
  { id: "tool-select", label: "Select tool", section: "Tools", keys: "V", run: (_, s) => s.setTool("select") },
  { id: "tool-wire", label: "Wire tool", section: "Tools", keys: "W", enabled: editable, run: (_, s) => s.setTool("wire") },
  { id: "tool-text", label: "Text tool", section: "Tools", keys: "T", enabled: editable, run: (_, s) => s.setTool("text") },
  { id: "tool-pan", label: "Pan tool", section: "Tools", keys: "H", run: (_, s) => s.setTool("pan") },
  { id: "tool-comment", label: "Comment tool", section: "Tools", keys: "C", enabled: (s) => !!s.version?.canComment, run: (_, s) => s.setTool("comment") },
  { id: "convertLines", label: "Convert selected lines to wires", section: "Tools", enabled: (s) => editable(s) && selLines(s).length > 0, run: (ui, s) => convertLines(ui, s, selLines(s).map((x) => x.id)) },
  {
    id: "convertPageLines",
    label: "Convert all drawn lines on this page to wires",
    section: "Page",
    enabled: (s) => editable(s) && s.page().shapes.some(isOpenPath),
    run: (ui, s) => convertLines(ui, s, s.page().shapes.filter(isOpenPath).map((x) => x.id)),
  },
  { id: "connect", label: "Connect pins…", section: "Tools", keys: "⇧W", enabled: editable, run: (ui) => ui.openDialog("connect") },
  { id: "block", label: "Create reusable block from selection…", section: "Tools", enabled: (s) => editable(s) && hasEls(s), run: (ui) => ui.openDialog("block") },
  { id: "createElement", label: "Create element from selection…", section: "Tools", enabled: (s) => hasEls(s), run: (ui) => ui.openDialog("createElement") },
  { id: "followLabel", label: "Go to other occurrence of label", section: "View", keys: "L", enabled: (s) => s.sel.elements.length + s.sel.wires.length > 0, run: (ui) => void ui.engine.current?.followSelection() },
  { id: "navBack", label: "Go back", section: "View", keys: "⌘[", enabled: () => true, run: (ui) => void ui.engine.current?.goBack() },
  { id: "fit", label: "Zoom to fit", section: "View", keys: "F", run: (ui) => ui.engine.current?.fit() },
  { id: "fitPage", label: "Zoom to page", section: "View", keys: "⇧F", run: (ui) => ui.engine.current?.fitPage() },
  { id: "zoomSel", label: "Zoom to selection", section: "View", keys: "Z", enabled: hasSel, run: (ui) => ui.engine.current?.zoomToSelection() },
  {
    id: "zoomNet",
    label: "Zoom to connected net",
    section: "View",
    enabled: hasSel,
    run: (ui) => {
      ui.engine.current?.selectNet();
      ui.engine.current?.zoomToSelection();
    },
  },
  { id: "zoom100", label: "Zoom to 100%", section: "View", keys: "0", run: (ui) => ui.engine.current?.zoomTo100() },
  { id: "zoomIn", label: "Zoom in", section: "View", keys: "+", run: (ui) => ui.engine.current?.zoomAt(1.25) },
  { id: "zoomOut", label: "Zoom out", section: "View", keys: "−", run: (ui) => ui.engine.current?.zoomAt(0.8) },
  { id: "grid", label: "Toggle grid", section: "View", keys: "G", run: (_, s) => s.set("gridVisible", !s.gridVisible) },
  {
    id: "addPage",
    label: "Add page",
    section: "Page",
    enabled: editable,
    run: (_, s) => {
      const id = uid();
      s.apply("Add page", (d) => {
        const p = newPage(d.pages.length, `Page ${d.pages.length + 1}`);
        p.id = id;
        const cur = d.pages.find((x) => x.id === s.pageId);
        if (cur) (p.border = { ...cur.border }), (p.titleBlock = { ...cur.titleBlock, fields: { ...cur.titleBlock.fields, title: p.title } });
        d.pages.push(p);
      });
      s.setPage(id);
    },
  },
  { id: "pageSettings", label: "Page settings…", section: "Page", run: (ui) => ui.openDialog("page") },
  { id: "styles", label: "Global styles…", section: "Project", keys: "⌘⇧S", run: (ui) => ui.openDialog("styles") },
  { id: "numbering", label: "Automatic numbering…", section: "Project", run: (ui) => ui.openDialog("numbering") },
  { id: "wiring", label: "Wiring & cables… (colours, cross-sections, cables)", section: "Project", run: (ui) => ui.openDialog("wiring") },
  { id: "projectProps", label: "Project properties…", section: "Project", run: (ui) => ui.openDialog("projectProps") },
  { id: "export", label: "Export…", section: "Project", keys: "⌘E", enabled: (s) => s.version?.canExport ?? true, run: (ui) => ui.openDialog("export") },
  { id: "compat", label: "File compatibility report", section: "Project", run: (ui) => ui.openDialog("compat") },
  { id: "save", label: "Save now", section: "Project", keys: "⌘S", enabled: editable, run: (ui) => ui.saveNow() },
  { id: "validate", label: "Run checks", section: "Review", run: (_, s) => s.set("panels", { ...s.panels, right: "validate" }) },
  { id: "compare", label: "Compare with another version…", section: "Review", run: (ui) => ui.openDialog("compare") },
  { id: "newVersion", label: "Start new version…", section: "Review", run: (ui) => ui.openDialog("newVersion") },
  { id: "submit", label: "Submit for review…", section: "Review", enabled: editable, run: (ui) => ui.openDialog("submit") },
  { id: "shortcuts", label: "Keyboard shortcuts", section: "Help", keys: "?", run: (ui) => ui.openDialog("shortcuts") },
];

export function runCommand(id: string, ui: EditorUI) {
  const c = COMMANDS.find((x) => x.id === id);
  const s = useEditor.getState();
  if (!c || (c.enabled && !c.enabled(s))) return false;
  void c.run(ui, s);
  return true;
}

function alignSel(d: import("@/core/model").Doc, s: EditorStore, a: "left" | "center" | "right" | "top" | "middle" | "bottom") {
  const p = getPage(d, s.pageId);
  const els = p.elements.filter((e) => s.sel.elements.includes(e.id) && !e.locked);
  const xs = els.map((e) => e.x), ys = els.map((e) => e.y);
  const target = a === "left" ? Math.min(...xs) : a === "right" ? Math.max(...xs) : a === "center" ? Math.round((Math.min(...xs) + Math.max(...xs)) / 20) * 10 + 5 : a === "top" ? Math.min(...ys) : a === "bottom" ? Math.max(...ys) : Math.round((Math.min(...ys) + Math.max(...ys)) / 20) * 10 + 5;
  for (const e of els) {
    const dx = a === "left" || a === "right" || a === "center" ? target - e.x : 0;
    const dy = a === "top" || a === "bottom" || a === "middle" ? target - e.y : 0;
    moveSelection(d, p, { ...emptySel(), elements: [e.id] }, { x: dx, y: dy });
  }
}

function distribute(d: import("@/core/model").Doc, s: EditorStore, axis: "x" | "y") {
  const p = getPage(d, s.pageId);
  const els = p.elements.filter((e) => s.sel.elements.includes(e.id) && !e.locked).sort((a, b) => a[axis] - b[axis]);
  if (els.length < 3) return;
  const first = els[0][axis], last = els[els.length - 1][axis];
  const step = (last - first) / (els.length - 1);
  els.forEach((e, i) => {
    const target = Math.round((first + step * i - 5) / 10) * 10 + 5;
    const delta = target - e[axis];
    moveSelection(d, p, { ...emptySel(), elements: [e.id] }, axis === "x" ? { x: delta, y: 0 } : { x: 0, y: delta });
  });
}
