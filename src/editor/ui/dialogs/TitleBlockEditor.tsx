"use client";
/**
 * Visual title block template editor: the template's grid at the page's width, where cells are
 * selected, dragged to another slot, merged/split, and column/row borders dragged to resize.
 * The inspector on the right edits a cell's kind, label, text (with %variables), alignment,
 * size and logo. Saving rewrites the template (and its QET xml) for every page that uses it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Columns2,
  Combine,
  ImagePlus,
  Rows2,
  SplitSquareHorizontal,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { useEditor } from "../../store";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Switch, Tip } from "@/components/ui/misc";
import type { Doc, Page, TitleBlockLogo, TitleBlockTemplate } from "@/core/model";
import { getPage } from "@/core/ops";
import { pageGeometry, tbTemplate, titleVars, subst } from "@/core/render/scene";
import { PT } from "@/core/render/symbol";
import { serializeTitleBlockTemplate, templateLogos, titleBlockColumnWidths } from "@/core/qet/titleblock";
import { logoDataUrl } from "@/core/logos";
import {
  addField,
  colSpec,
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  mergeCells,
  moveCell,
  occupancy,
  parseColSpec,
  removeCell,
  resizeCol,
  resizeRow,
  splitCell,
  updateCell,
  type TbCell,
} from "@/core/titleblock-edit";
import { readLogoFile } from "../logoUpload";
import { cn } from "@/lib/utils";

type T = TitleBlockTemplate;

/** QET's title block variables, with what fills them */
const VARIABLES: { v: string; label: string }[] = [
  { v: "author", label: "Author (page field)" },
  { v: "date", label: "Date (page field)" },
  { v: "title", label: "Sheet title (page field, else page name)" },
  { v: "filename", label: "File name (page field)" },
  { v: "indexrev", label: "Revision (page field)" },
  { v: "version", label: "Version" },
  { v: "plant", label: "Plant (page field)" },
  { v: "locmach", label: "Location (page field)" },
  { v: "folio", label: "Sheet no. (e.g. 3/12)" },
  { v: "id", label: "Page number" },
  { v: "total", label: "Page count" },
  { v: "projecttitle", label: "Project name" },
];
const FIELD_LABEL: Record<string, string> = Object.fromEntries(VARIABLES.map((x) => [x.v, x.label.replace(/ \(.*$/, "")]));

type Drag =
  | { kind: "cell"; index: number; x0: number; y0: number; moved: boolean; target: { row: number; col: number } | null }
  | { kind: "col"; i: number; x0: number; start: T; widths: number[] }
  | { kind: "row"; i: number; y0: number; start: T };

/** In the drawing editor: edits a template of this project (all pages using it, or a copy for this page). */
export function TitleBlockEditor({ onClose, arg }: { onClose: () => void; arg?: { template?: string } }) {
  const doc = useEditor((s) => s.doc) as Doc;
  const pageId = useEditor((s) => s.pageId);
  const editable = useEditor((s) => !s.version || s.version.editable);
  const page = getPage(doc, pageId) as Page;
  const origName = arg?.template ?? page.titleBlock.template;
  const orig = doc.titleBlocks[origName] ?? tbTemplate(doc, page);
  const [asCopy, setAsCopy] = useState(false);
  const users = doc.pages.filter((p) => p.titleBlock.template === origName).length;
  const vars = useMemo(() => titleVars({ doc, page }), [doc, page]);
  const available = useMemo(() => {
    const m = new Map<string, TitleBlockLogo>();
    for (const tb of Object.values(doc.titleBlocks)) for (const [n, l] of Object.entries(templateLogos(tb))) if (!m.has(n)) m.set(n, l);
    return m;
  }, [doc.titleBlocks]);
  return (
    <TitleBlockDesigner
      initial={{ ...orig, name: origName }}
      width={pageGeometry(doc, page).border.w}
      vars={vars}
      availableLogos={available}
      extraVariables={Object.keys(doc.meta.props ?? {})}
      editable={editable}
      title="Title block template"
      description={`Changes apply to every page using “${origName}”${users > 1 ? ` (${users} pages)` : ""}. Drag cells to move them, drag the borders to resize.`}
      footer={
        <label className="mr-auto flex items-center gap-1.5 text-2xs text-muted">
          <Switch checked={asCopy} onCheckedChange={setAsCopy} /> Save as a new template for this page
        </label>
      }
      onClose={onClose}
      onSave={(out) => {
        const name = out.name;
        const renamed = name !== origName;
        if ((asCopy || renamed) && doc.titleBlocks[name]) return void toast.error(`A template called “${name}” already exists in this project`);
        useEditor.getState().apply(asCopy ? "New title block template" : "Edit title block template", (d) => {
          if (asCopy) {
            d.titleBlocks[name] = out;
            getPage(d, pageId).titleBlock.template = name;
            return;
          }
          if (renamed) {
            delete d.titleBlocks[origName];
            for (const p of d.pages) if (p.titleBlock.template === origName) p.titleBlock.template = name;
          }
          d.titleBlocks[name] = out;
        });
        toast.success(asCopy ? `Saved as “${name}” for this page` : `Title block updated on ${users || 1} page${users === 1 ? "" : "s"}`);
        onClose();
      }}
    />
  );
}

export type DesignerProps = {
  initial: TitleBlockTemplate;
  /** frame width the template is laid out at */
  width: number;
  /** variable values for the preview */
  vars: Record<string, string>;
  /** logos that can be picked besides the template's own */
  availableLogos?: Map<string, TitleBlockLogo>;
  /** more %variables offered in the picker (project properties) */
  extraVariables?: string[];
  editable: boolean;
  title: string;
  description: string;
  footer?: React.ReactNode;
  saveLabel?: string;
  defaultShowVars?: boolean;
  onClose: () => void;
  /** the edited template with its regenerated QET xml (logos inside) */
  onSave: (t: TitleBlockTemplate) => void | Promise<void>;
};

/** The visual title block editor itself (also used in Administration → Title block layouts). */
export function TitleBlockDesigner({ initial: orig, width: W, vars, availableLogos, extraVariables = [], editable, title, description, footer, saveLabel = "Save template", defaultShowVars = false, onClose, onSave }: DesignerProps) {
  const [t, setT] = useState<T>(() => ({ ...orig, rows: [...orig.rows], cols: orig.cols.map((c) => ({ ...c })), cells: orig.cells.filter((c) => c.type !== "empty").map((c) => ({ ...c })), logos: { ...templateLogos(orig) } }));
  const [history, setHistory] = useState<T[]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [slot, setSlot] = useState<{ row: number; col: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showVars, setShowVars] = useState(defaultShowVars);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  // 100 % = the whole template fits the canvas width
  const canvas = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(900);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(Math.max(300, el.clientWidth - 26)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = avail / W;
  const z = fit * zoom;
  const widths = titleBlockColumnWidths(t, W);
  const colX = [0];
  for (const w of widths) colX.push(colX[colX.length - 1] + w);
  const rowY = [0];
  for (const h of t.rows) rowY.push(rowY[rowY.length - 1] + h);
  const H = rowY[rowY.length - 1];
  const occ = useMemo(() => occupancy(t), [t]);
  const logos = t.logos ?? {};
  const projectLogos = useMemo(() => {
    const m = new Map<string, TitleBlockLogo>();
    for (const [n, l] of Object.entries(logos)) m.set(n, l);
    for (const [n, l] of availableLogos ?? []) if (!m.has(n)) m.set(n, l);
    return m;
  }, [availableLogos, logos]);

  /** every change goes through here so it can be undone */
  const change = (n: T | null, keepSel = true) => {
    if (!n) return toast.error("That does not fit: another cell is in the way");
    setHistory((h) => [...h.slice(-49), t]);
    setT(n);
    if (!keepSel) setSel([]);
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setT(prev);
    setSel([]);
  };

  const one = sel.length === 1 ? sel[0] : null;
  const cur: TbCell | null = one !== null ? t.cells[one] ?? null : null;
  const focus = cur ? { row: cur.row, col: cur.col } : slot;

  /** grid slot under a client point */
  const slotAt = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    const x = (cx - r.left) / z, y = (cy - r.top) / z;
    const col = colX.findIndex((v, i) => i < widths.length && x >= v && x < colX[i + 1]);
    const row = rowY.findIndex((v, i) => i < t.rows.length && y >= v && y < rowY[i + 1]);
    return col < 0 || row < 0 ? null : { row, col };
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === "col") setT(resizeCol(drag.start, drag.i, (e.clientX - drag.x0) / z, drag.widths, W));
    else if (drag.kind === "row") setT(resizeRow(drag.start, drag.i, drag.start.rows[drag.i] + (e.clientY - drag.y0) / z));
    else {
      const moved = drag.moved || Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4;
      setDrag({ ...drag, moved, target: moved ? slotAt(e.clientX, e.clientY) : null });
    }
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.kind === "cell" && drag.moved && drag.target) {
      const n = moveCell(t, drag.index, drag.target.row, drag.target.col);
      if (n) change(n);
      else if (drag.target.row !== t.cells[drag.index].row || drag.target.col !== t.cells[drag.index].col) toast.error("Drop on a free slot or a cell of the same size (they swap)");
    }
    if (drag.kind !== "cell") setHistory((h) => [...h.slice(-49), drag.start]);
    setDrag(null);
  };

  const save = async () => {
    const name = t.name.trim();
    if (!name) return toast.error("Give the template a name");
    const used = new Set(t.cells.filter((c) => c.type === "logo" && c.value).map((c) => c.value!));
    const keptLogos = Object.fromEntries(Object.entries(logos).filter(([n]) => used.has(n)));
    let xml: string;
    try {
      xml = serializeTitleBlockTemplate({ ...t, name, logos: keptLogos, xml: orig.xml });
    } catch (e) {
      return toast.error(`Could not save the template: ${(e as Error).message}`);
    }
    setSaving(true);
    try {
      await onSave({ name, rows: t.rows, cols: t.cols, cells: t.cells.filter((c) => c.type !== "empty"), xml });
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (f: File) => {
    if (one === null) return;
    try {
      const { name, logo, note } = await readLogoFile(f);
      let n = name;
      for (let i = 2; projectLogos.has(n); i++) n = name.replace(/(\.[^.]+)$/, `-${i}$1`);
      change({ ...updateCell(t, one, { value: n }), logos: { ...logos, [n]: logo } });
      if (note) toast.success(`Logo ${note}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const chooseLogo = (n: string) => {
    if (one === null) return;
    const l = projectLogos.get(n);
    change({ ...updateCell(t, one, { value: n }), logos: l ? { ...logos, [n]: l } : logos });
  };

  const text = (c: TbCell) => (showVars ? c.value ?? "" : subst(c.value ?? "", vars));
  const isVar = (c: TbCell) => /%\{?[\w-]+\}?/.test(c.value ?? "");
  const literalKnown = cur && cur.type === "field" && cur.name && VARIABLES.some((x) => x.v === cur.name) && !isVar(cur) && cur.value;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={description} wide="xl" className="max-w-[min(1500px,96vw)]">
        <div className="space-y-2" onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-1">
            <Tool icon={<ArrowUpToLine />} tip="Insert row above" disabled={!focus} onClick={() => focus && change(insertRow(t, focus.row))} />
            <Tool icon={<ArrowDownToLine />} tip="Insert row below" disabled={!focus} onClick={() => focus && change(insertRow(t, focus.row + 1))} />
            <Tool icon={<Rows2 />} tip="Delete row" disabled={!focus || t.rows.length < 2} onClick={() => focus && change(deleteRow(t, focus.row), false)} danger />
            <span className="mx-1 h-4 w-px bg-border" />
            <Tool icon={<ArrowLeftToLine />} tip="Insert column left" disabled={!focus} onClick={() => focus && change(insertCol(t, focus.col))} />
            <Tool icon={<ArrowRightToLine />} tip="Insert column right" disabled={!focus} onClick={() => focus && change(insertCol(t, focus.col + 1))} />
            <Tool icon={<Columns2 />} tip="Delete column" disabled={!focus || t.cols.length < 2} onClick={() => focus && change(deleteCol(t, focus.col), false)} danger />
            <span className="mx-1 h-4 w-px bg-border" />
            <Tool
              icon={<Combine />}
              tip="Merge selected cells (Shift+click to select several)"
              disabled={sel.length < 2}
              onClick={() => {
                const m = mergeCells(t, sel);
                if (!m) return toast.error("Only cells forming a rectangle with nothing else inside can be merged");
                change(m.t);
                setSel([m.index]);
              }}
            />
            <Tool icon={<SplitSquareHorizontal />} tip="Split (undo merge)" disabled={!cur || (!cur.rowspan && !cur.colspan)} onClick={() => one !== null && change(splitCell(t, one))} />
            <Tool icon={<Trash2 />} tip="Delete cell" disabled={!sel.length} onClick={() => change(sel.sort((a, b) => b - a).reduce((acc, i) => removeCell(acc, i), t), false)} danger />
            <span className="mx-1 h-4 w-px bg-border" />
            <Button size="xs" variant="ghost" disabled={!history.length} onClick={undo}>
              Undo
            </Button>
            <div className="ml-auto flex items-center gap-2 text-2xs text-muted">
              <label className="flex items-center gap-1.5">
                <Switch checked={showVars} onCheckedChange={setShowVars} /> Show variables
              </label>
              <Tool icon={<ZoomOut />} tip="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((v) => Math.max(1, v - 0.5))} />
              <span className="w-8 text-center tabular">{Math.round(zoom * 100)}%</span>
              <Tool icon={<ZoomIn />} tip="Zoom in" disabled={zoom >= 4} onClick={() => setZoom((v) => Math.min(4, v + 0.5))} />
            </div>
          </div>

          <div className="grid grid-cols-[1fr_260px] gap-3">
            {/* canvas */}
            <div ref={canvas} className="min-w-0 self-start overflow-auto rounded-md border border-border bg-panel-2 p-3 pt-6">
              <div className="relative select-none" style={{ width: W * z, height: H * z + 2 }}>
                {/* column specs */}
                {widths.map((w, i) => (
                  <ColHeader key={`h${i}`} x={colX[i] * z} w={w * z} spec={colSpec(t.cols[i])} onSet={(c) => change({ ...t, cols: t.cols.map((o, k) => (k === i ? c : o)) })} />
                ))}
                <div ref={box} className="absolute inset-0 bg-white" style={{ height: H * z }}>
                  {/* free slots */}
                  {t.rows.map((rh, r) =>
                    widths.map((cw, c) =>
                      occ.has(`${r}:${c}`) ? null : (
                        <button
                          key={`s${r}:${c}`}
                          className={cn("absolute border border-dashed border-border-strong text-2xs text-subtle hover:bg-accent-soft", slot?.row === r && slot?.col === c && !cur && "bg-accent-soft ring-1 ring-accent")}
                          style={{ left: colX[c] * z, top: rowY[r] * z, width: cw * z, height: rh * z }}
                          onClick={() => {
                            setSel([]);
                            setSlot({ row: r, col: c });
                          }}
                          onDoubleClick={() => {
                            const a = addField(t, r, c, { size: 8 });
                            change(a.t);
                            setSel([a.index]);
                          }}
                          title="Double-click to add a field here"
                        >
                          +
                        </button>
                      ),
                    ),
                  )}
                  {/* cells */}
                  {t.cells.map((c, i) => {
                    if (c.type === "empty" || c.row >= t.rows.length || c.col >= widths.length) return null;
                    const r2 = Math.min(t.rows.length, c.row + c.rowspan + 1), c2 = Math.min(widths.length, c.col + c.colspan + 1);
                    const x = colX[c.col], y = rowY[c.row], w = colX[c2] - x, h = rowY[r2] - y;
                    const size = (c.size ?? 8) * PT * z;
                    const selected = sel.includes(i);
                    const logo = c.type === "logo" && c.value ? logos[c.value] : undefined;
                    const dragging = drag?.kind === "cell" && drag.index === i && drag.moved;
                    return (
                      <div
                        key={i}
                        data-tb-cell={i}
                        className={cn("absolute cursor-grab overflow-hidden border border-neutral-800 bg-white", selected && "z-10 outline outline-2 outline-accent", dragging && "opacity-40")}
                        style={{ left: x * z, top: y * z, width: w * z, height: h * z }}
                        onPointerDown={(e) => {
                          if (!editable) return;
                          e.currentTarget.setPointerCapture?.(e.pointerId);
                          setSlot(null);
                          setSel((s) => (e.shiftKey ? (s.includes(i) ? s.filter((k) => k !== i) : [...s, i]) : [i]));
                          setDrag({ kind: "cell", index: i, x0: e.clientX, y0: e.clientY, moved: false, target: null });
                        }}
                      >
                        {c.type === "logo" ? (
                          logo ? (
                            <img src={logoDataUrl(logo)} alt={c.value} className="pointer-events-none size-full object-contain p-0.5" />
                          ) : (
                            <span className="flex size-full items-center justify-center text-2xs text-subtle">logo</span>
                          )
                        ) : (
                          <>
                            {c.showLabel && c.label && (
                              <span className="absolute left-0.5 top-0 whitespace-nowrap text-neutral-500" style={{ fontSize: size * 0.8, lineHeight: 1.1 }}>
                                {c.label}
                              </span>
                            )}
                            <span
                              className={cn("absolute inset-x-0.5 whitespace-nowrap", isVar(c) ? "text-blue-700" : "text-neutral-900", c.name === "title" && "font-semibold")}
                              style={{ fontSize: size, lineHeight: 1.1, textAlign: c.align ?? "left", top: c.showLabel && c.label ? "55%" : "50%", transform: "translateY(-50%)" }}
                            >
                              {text(c)}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {/* drop target */}
                  {drag?.kind === "cell" && drag.moved && drag.target && (
                    <div
                      className="pointer-events-none absolute z-20 border-2 border-accent bg-accent/10"
                      style={{
                        left: colX[drag.target.col] * z,
                        top: rowY[drag.target.row] * z,
                        width: (colX[Math.min(widths.length, drag.target.col + t.cells[drag.index].colspan + 1)] - colX[drag.target.col]) * z,
                        height: (rowY[Math.min(t.rows.length, drag.target.row + t.cells[drag.index].rowspan + 1)] - rowY[drag.target.row]) * z,
                      }}
                    />
                  )}
                  {/* column borders */}
                  {widths.slice(0, -1).map((_, i) => (
                    <div
                      key={`cb${i}`}
                      className="absolute top-0 z-30 w-2 -translate-x-1 cursor-col-resize hover:bg-accent/40"
                      style={{ left: colX[i + 1] * z, height: H * z }}
                      title="Drag to resize"
                      onPointerDown={(e) => {
                        if (!editable) return;
                        e.stopPropagation();
                        setDrag({ kind: "col", i, x0: e.clientX, start: t, widths });
                      }}
                    />
                  ))}
                  {/* row borders */}
                  {t.rows.map((_, i) => (
                    <div
                      key={`rb${i}`}
                      className="absolute left-0 z-30 h-2 -translate-y-1 cursor-row-resize hover:bg-accent/40"
                      style={{ top: rowY[i + 1] * z, width: W * z }}
                      title={`Row ${i + 1}: ${t.rows[i]} px — drag to resize`}
                      onPointerDown={(e) => {
                        if (!editable) return;
                        e.stopPropagation();
                        setDrag({ kind: "row", i, y0: e.clientY, start: t });
                      }}
                    />
                  ))}
                </div>
              </div>
              <p className="mt-2 text-2xs text-subtle">
                Width follows the page frame ({Math.round(W)} px). Blue text comes from variables, filled per page. Double-click a free slot to add a field.
              </p>
            </div>

            {/* inspector */}
            <div className="space-y-2.5 text-xs">
              <label className="block space-y-1">
                <span className="text-2xs text-muted">Template name</span>
                <Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} className="h-7 text-xs" aria-label="Template name" />
              </label>
              {!cur && sel.length > 1 && <p className="text-2xs text-muted">{sel.length} cells selected — merge them or delete them.</p>}
              {!cur && sel.length <= 1 && <p className="text-2xs text-muted">Select a cell to edit it. Shift+click selects several cells to merge.</p>}
              {cur && one !== null && (
                <div className="space-y-2 border-t border-border pt-2" data-testid="tb-cell-inspector">
                  <div className="flex items-center gap-2">
                    <span className="w-16 text-2xs text-muted">Kind</span>
                    <NativeSelect value={cur.type} onChange={(e) => change(updateCell(t, one, { type: e.target.value as TbCell["type"], ...(e.target.value === "logo" ? { value: "" } : {}) }))} className="h-7 text-xs" aria-label="Cell kind">
                      <option value="field">Text field</option>
                      <option value="logo">Logo</option>
                    </NativeSelect>
                  </div>
                  {cur.type === "field" ? (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="w-16 text-2xs text-muted">Label</span>
                        <Input value={cur.label ?? ""} onChange={(e) => setT(updateCell(t, one, { label: e.target.value }))} className="h-7 text-xs" aria-label="Cell label" />
                        <Tip content="Show the label">
                          <Switch checked={cur.showLabel !== false} onCheckedChange={(v) => change(updateCell(t, one, { showLabel: v }))} />
                        </Tip>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="w-16 text-2xs text-muted">Text</span>
                          <Input value={cur.value ?? ""} onChange={(e) => setT(updateCell(t, one, { value: e.target.value }))} className="h-7 font-mono text-xs" aria-label="Cell text" placeholder="Fixed text or %author" />
                        </div>
                        <NativeSelect
                          value=""
                          onChange={(e) => e.target.value && change(updateCell(t, one, { value: e.target.value === "__clear" ? "" : `%${e.target.value}` }))}
                          className="h-6 text-2xs"
                          aria-label="Fill from"
                        >
                          <option value="">Fill from a variable…</option>
                          {VARIABLES.map((x) => (
                            <option key={x.v} value={x.v}>
                              %{x.v} — {x.label}
                            </option>
                          ))}
                          {extraVariables.map((k) => (
                            <option key={k} value={k}>
                              %{k} — project property
                            </option>
                          ))}
                        </NativeSelect>
                        {literalKnown && (
                          <div className="rounded border border-warning/30 bg-warning-soft p-1.5 text-2xs">
                            This cell always shows “{cur.value}”, so the page’s {FIELD_LABEL[cur.name!] ?? cur.name} field is ignored.{" "}
                            <button className="font-medium text-accent hover:underline" onClick={() => change(updateCell(t, one, { value: `%${cur.name}` }))}>
                              Use the page field instead
                            </button>
                          </div>
                        )}
                        {isVar(cur) && <p className="text-2xs text-subtle">Shows “{subst(cur.value ?? "", vars) || "(empty)"}” on this page.</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-16 text-2xs text-muted">Align</span>
                        {(["left", "center", "right"] as const).map((a) => (
                          <Button key={a} size="icon-sm" variant={(cur.align ?? "left") === a ? "secondary" : "ghost"} onClick={() => change(updateCell(t, one, { align: a }))} aria-label={`Align ${a}`}>
                            {a === "left" ? <AlignLeft /> : a === "center" ? <AlignCenter /> : <AlignRight />}
                          </Button>
                        ))}
                        <span className="ml-2 text-2xs text-muted">Size</span>
                        <Input type="number" min={4} max={40} value={cur.size ?? 8} onChange={(e) => setT(updateCell(t, one, { size: Math.max(4, Math.min(40, Number(e.target.value) || 8)) }))} className="h-7 w-14 text-xs" aria-label="Font size" />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-16 text-2xs text-muted">Name</span>
                        <Input value={cur.name ?? ""} onChange={(e) => setT(updateCell(t, one, { name: e.target.value.replace(/\s+/g, "_") }))} className="h-7 font-mono text-xs" aria-label="Cell name" placeholder="identifier" />
                      </div>
                    </>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="flex h-16 items-center justify-center rounded border border-border bg-white">
                        {cur.value && logos[cur.value] ? <img src={logoDataUrl(logos[cur.value])} alt="" className="max-h-full max-w-full object-contain p-1" /> : <span className="text-2xs text-subtle">No logo</span>}
                      </div>
                      <div className="flex gap-1">
                        <NativeSelect value={cur.value && projectLogos.has(cur.value) ? cur.value : ""} onChange={(e) => (e.target.value ? chooseLogo(e.target.value) : change(updateCell(t, one, { value: "" })))} className="h-7 text-xs" aria-label="Logo">
                          <option value="">— no logo —</option>
                          {[...projectLogos.keys()].map((n) => (
                            <option key={n}>{n}</option>
                          ))}
                        </NativeSelect>
                        <Button size="sm" onClick={() => logoInput.current?.click()}>
                          <ImagePlus /> Upload
                        </Button>
                      </div>
                      <input
                        ref={logoInput}
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void uploadLogo(f);
                        }}
                      />
                    </div>
                  )}
                  <p className="text-2xs text-subtle">
                    Row {cur.row + 1}, column {cur.col + 1}
                    {cur.rowspan || cur.colspan ? ` · spans ${cur.rowspan + 1}×${cur.colspan + 1}` : ""}
                  </p>
                </div>
              )}
              {slot && !cur && (
                <Button
                  size="sm"
                  onClick={() => {
                    const a = addField(t, slot.row, slot.col, { size: 8 });
                    change(a.t);
                    setSel([a.index]);
                  }}
                >
                  Add a field in row {slot.row + 1}, column {slot.col + 1}
                </Button>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          {footer ?? <span className="mr-auto" />}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!editable || saving} onClick={() => void save()}>
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Tool({ icon, tip, onClick, disabled, danger }: { icon: React.ReactNode; tip: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Tip content={tip}>
      <Button size="icon-sm" variant="ghost" disabled={disabled} onClick={onClick} aria-label={tip} className={danger ? "hover:text-danger" : undefined}>
        {icon}
      </Button>
    </Tip>
  );
}

/** column width spec above the grid; click to edit ("80px", "r25%", "t10%") */
function ColHeader({ x, w, spec, onSet }: { x: number; w: number; spec: string; onSet: (c: NonNullable<ReturnType<typeof parseColSpec>>) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <div className="absolute -top-5 flex h-4 justify-center" style={{ left: x, width: w }}>
      {edit === null ? (
        <button className="truncate px-0.5 font-mono text-[10px] text-subtle hover:text-accent" onClick={() => setEdit(spec)} title="Column width: px = fixed, r% = share of the remaining width, t% = share of the total width">
          {spec}
        </button>
      ) : (
        <input
          autoFocus
          className="h-4 w-16 rounded border border-accent bg-panel px-1 font-mono text-[10px] outline-none"
          value={edit}
          onChange={(e) => setEdit(e.target.value)}
          onBlur={() => setEdit(null)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setEdit(null);
            if (e.key === "Enter") {
              const c = parseColSpec(edit);
              if (c) onSet(c);
              else toast.error("Use 80px, r25% or t10%");
              setEdit(null);
            }
          }}
        />
      )}
    </div>
  );
}
