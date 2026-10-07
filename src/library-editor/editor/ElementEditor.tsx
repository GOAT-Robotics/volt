"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Circle,
  CircleDot,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  Grid3x3,
  Keyboard,
  Loader2,
  Magnet,
  Maximize,
  Minus,
  MousePointer2,
  PenLine,
  Plus,
  Redo2,
  RotateCw,
  Save,
  Spline,
  Square,
  Type,
  Undo2,
  Variable,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import type { ElementDef, PinDef } from "@/core/model";
import { parseElmt, serializeElmt } from "@/core/qet/elmt";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Kbd, Spinner, Tip, TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/misc";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { INFO_KEYS, finalizeDef, type Frame } from "@/lib/library/elmt-tools";
import type { ElementDetail, LibUser } from "../types";
import { WorkflowBar } from "../shared/WorkflowBar";
import { RevisionsPanel } from "../shared/RevisionsPanel";
import { PartDocuments } from "@/components/volt/PartDocuments";
import { useEd, docFromDef, isDirty, stripId, type MetaForm, type ToolId } from "./store";
import { SymbolCanvas, type CanvasApi } from "./SymbolCanvas";
import { Inspector } from "./Inspector";
import { LivePreview, MetadataForm, PinTable, ValidationList, useIssues } from "./panels";
import { copySelection, cutSelection, deleteSelection, duplicateSelection, mirrorSelection, nudge, paste, rotateSelection, selectAll, zOrder } from "./actions";
import { Seg } from "./fields";

const TOOLS: { id: ToolId; label: string; key: string; icon: React.ReactNode; hint: string }[] = [
  { id: "select", label: "Select / move", key: "V", icon: <MousePointer2 />, hint: "Click to select, drag to move. Drag on empty space to box-select (left→right: fully inside, right→left: touching). Shift adds." },
  { id: "line", label: "Line", key: "L", icon: <PenLine />, hint: "Drag, or click start and end. Shift snaps to 45°." },
  { id: "rect", label: "Rectangle", key: "R", icon: <Square />, hint: "Drag from corner to corner. Shift makes a square." },
  { id: "ellipse", label: "Circle / ellipse", key: "E", icon: <Circle />, hint: "Drag the bounding box. Shift makes a circle." },
  { id: "arc", label: "Arc", key: "A", icon: <Spline />, hint: "Click the centre, then the start point (sets radius), then the end point." },
  { id: "polygon", label: "Polyline / polygon", key: "P", icon: <Waypoints />, hint: "Click points. Double-click or Enter to finish, click the first point to close. Backspace removes the last point." },
  { id: "text", label: "Static text", key: "T", icon: <Type />, hint: "Click to place a fixed text." },
  { id: "dyntext", label: "Dynamic text", key: "D", icon: <Variable />, hint: "Click to place a text filled in per component (reference, function…)." },
  { id: "pin", label: "Pin (connection point)", key: "N", icon: <CircleDot />, hint: "Click where a wire connects. Direction is automatic; press R to turn it. Numbers count up." },
];

function metaFromDetail(d: ElementDetail, def: ElementDef): MetaForm {
  const m = { ...d.meta };
  const pick = (k: string, fallback = "") => {
    const v = m[k] ?? fallback;
    delete m[k];
    return v;
  };
  const out: MetaForm = {
    category: d.category,
    prefix: d.prefix,
    description: d.description,
    tags: d.tags,
    manufacturer: pick("manufacturer", def.info.manufacturer ?? ""),
    partNumber: pick("partNumber", def.info.manufacturer_reference ?? ""),
    function: pick("function", def.info.function ?? ""),
    license: d.license ?? "",
    attribution: d.attribution ?? "",
    source: d.source ?? "",
    extra: {},
  };
  delete m.requiredPins;
  delete m.informations;
  out.extra = m;
  return out;
}

export function ElementEditor({ id, user }: { id: string; user: LibUser }) {
  const [detail, setDetail] = useState<ElementDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [base, setBase] = useState<ElementDef | null>(null);
  const [tab, setTab] = useState("props");
  const [saveOpen, setSaveOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [revKey, setRevKey] = useState(0);
  const canvasApi = useRef<CanvasApi | null>(null);
  const dirty = useEd((s) => isDirty(s));
  const tool = useEd((s) => s.tool);
  const metaPart = useEd((s) => s.meta);
  const issues = useIssues();

  const load = useCallback(
    async (keepDoc = false) => {
      try {
        const d = await api<ElementDetail>(`/api/library/elements/${id}`);
        setDetail(d);
        if (d.kind !== "ELEMENT") return;
        const def = parseElmt(d.content, { id: d.id, category: d.category });
        setBase(def);
        if (!keepDoc) {
          const doc = docFromDef(def);
          const req = new Set((d.meta.requiredPins ?? "").split(",").filter(Boolean));
          doc.pins = doc.pins.map((p) => (req.has(p.id) || req.has(p.number) ? { ...p, required: true } : p));
          useEd.getState().load(doc, metaFromDetail(d, def), { width: def.width, height: def.height, hotspotX: def.hotspotX, hotspotY: def.hotspotY });
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [id],
  );
  useEffect(() => {
    useEd.getState().setTool("select");
    load();
  }, [load]);

  useEffect(() => {
    api<{ items: { category: string }[] }>(`/api/library/elements?scope=all&kind=ELEMENT&limit=3000`)
      .then((j) => setCategories([...new Set(j.items.map((i) => i.category).filter(Boolean))].sort()))
      .catch(() => {});
  }, []);

  const readOnly = !detail?.access.canEdit;

  /* ------------------------- unsaved-changes guard ------------------------- */
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (isDirty(useEd.getState())) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
      const url = new URL(a.href, location.href);
      if (url.pathname === location.pathname) return;
      if (isDirty(useEd.getState()) && !confirm("You have unsaved changes to this element. Leave without saving?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", before);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("click", click, true);
    };
  }, []);

  /* ------------------------- keyboard shortcuts ------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector("[role=dialog]")) return;
      const st = useEd.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "s") {
        e.preventDefault();
        if (!readOnly) setSaveOpen(true);
        return;
      }
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        st.redo();
        return;
      }
      if (k === "f" && !mod) return canvasApi.current?.fit();
      if ((k === "+" || k === "=") && !mod) return canvasApi.current?.zoom(1.25);
      if (k === "-" && !mod) return canvasApi.current?.zoom(0.8);
      if (k === "?" || (k === "/" && e.shiftKey)) return setKeysOpen(true);
      if (k === "g" && !mod) return st.set({ showGrid: !st.showGrid });
      if (k === "escape") {
        st.setSel([]);
        st.setTool("select");
        return;
      }
      if (mod && k === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && k === "c") {
        if (copySelection()) e.preventDefault();
        return;
      }
      if (readOnly) return;
      if (!mod && !e.altKey) {
        const tl = TOOLS.find((x) => x.key.toLowerCase() === k);
        if (tl && !(st.tool === "pin" && k === "r")) {
          st.setTool(tl.id);
          return;
        }
      }
      if (k === "delete" || k === "backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (mod && k === "x") return (e.preventDefault(), cutSelection());
      if (mod && k === "v") return (e.preventDefault(), paste());
      if (mod && k === "d") return (e.preventDefault(), duplicateSelection());
      if (mod && k === "r") return (e.preventDefault(), rotateSelection(e.shiftKey ? -1 : 1));
      if (mod && k === "m") return (e.preventDefault(), mirrorSelection(e.shiftKey ? "v" : "h"));
      if (mod && (k === "]" || k === "}")) return (e.preventDefault(), zOrder(e.shiftKey ? "front" : "forward"));
      if (mod && (k === "[" || k === "{")) return (e.preventDefault(), zOrder(e.shiftKey ? "back" : "backward"));
      const step = e.shiftKey ? 10 : st.grid;
      if (k === "arrowleft") return (e.preventDefault(), nudge(-step, 0));
      if (k === "arrowright") return (e.preventDefault(), nudge(step, 0));
      if (k === "arrowup") return (e.preventDefault(), nudge(0, -step));
      if (k === "arrowdown") return (e.preventDefault(), nudge(0, step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly]);

  // expose perf for automated checks
  useEffect(() => {
    (window as unknown as { __symed?: unknown }).__symed = { perf: () => canvasApi.current?.perf() ?? [], store: useEd };
  }, []);

  if (err)
    return (
      <div className="p-10 text-center text-sm text-muted">
        <p className="font-medium text-fg">Could not open this element</p>
        <p className="mt-1 text-xs">{err}</p>
      </div>
    );
  if (!detail || !base)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  const errors = issues.filter((i) => i.level === "error");
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <WorkflowBar
        d={detail}
        user={user}
        dirty={dirty}
        reload={() => (load(true), setRevKey((x) => x + 1))}
        extra={
          !readOnly && (
            <Tip content={errors.length ? `${errors.length} problem(s) to fix first` : "Save a new revision"} shortcut="Ctrl S">
              <Button size="sm" variant={dirty ? "primary" : "secondary"} onClick={() => setSaveOpen(true)} aria-label="Save revision">
                <Save /> Save revision{dirty ? " •" : ""}
              </Button>
            </Tip>
          )
        }
      />
      {readOnly && (
        <div className="flex items-center gap-2 border-b border-border bg-info-soft px-4 py-1.5 text-2xs text-muted">
          <Eye className="size-3.5" /> View only — use “Duplicate to my library” in the ⋯ menu to make your own editable copy.
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* tools */}
        <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-border bg-panel py-2" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
          {TOOLS.map((t) => (
            <Tip key={t.id} content={t.label} shortcut={t.key} side="right">
              <Button size="icon" variant="tool" active={tool === t.id} disabled={readOnly && t.id !== "select"} aria-label={`${t.label} (${t.key})`} aria-pressed={tool === t.id} onClick={() => useEd.getState().setTool(t.id)}>
                {t.icon}
              </Button>
            </Tip>
          ))}
          <div className="my-1 h-px w-6 bg-border" />
          <Tip content="Keyboard shortcuts" shortcut="?" side="right">
            <Button size="icon" variant="tool" aria-label="Keyboard shortcuts" onClick={() => setKeysOpen(true)}>
              <Keyboard />
            </Button>
          </Tip>
        </div>
        {/* canvas */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <OptionsBar readOnly={readOnly} canvasApi={canvasApi} />
          <ContextMenu>
            <ContextMenuTrigger asChild disabled={readOnly || tool === "polygon"}>
              <div className="relative min-h-0 flex-1">
                <SymbolCanvas apiRef={canvasApi} readOnly={readOnly} />
                <div className="pointer-events-none absolute bottom-2 left-2 max-w-md rounded-md bg-panel/90 px-2 py-1 text-2xs text-muted shadow-float backdrop-blur">{TOOLS.find((t) => t.id === tool)?.hint}</div>
                <div className="absolute bottom-2 right-2 rounded-lg border border-border bg-panel/95 p-2 shadow-float backdrop-blur">
                  <LivePreview base={base} />
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem shortcut="Ctrl X" onSelect={cutSelection}>
                Cut
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl C" onSelect={() => copySelection()}>
                Copy
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl V" onSelect={() => paste()}>
                Paste
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl D" onSelect={duplicateSelection}>
                Duplicate
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem shortcut="Ctrl R" onSelect={() => rotateSelection(1)}>
                Rotate 90°
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl M" onSelect={() => mirrorSelection("h")}>
                Mirror horizontally
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl ⇧ M" onSelect={() => mirrorSelection("v")}>
                Mirror vertically
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem shortcut="Ctrl ⇧ ]" onSelect={() => zOrder("front")}>
                Bring to front
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl ]" onSelect={() => zOrder("forward")}>
                Bring forward
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl [" onSelect={() => zOrder("backward")}>
                Send backward
              </ContextMenuItem>
              <ContextMenuItem shortcut="Ctrl ⇧ [" onSelect={() => zOrder("back")}>
                Send to back
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem danger shortcut="Del" onSelect={deleteSelection}>
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
        {/* right panel */}
        <aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-panel" aria-label="Element properties">
          <TabsRoot value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="overflow-x-auto px-2 [scrollbar-width:none] [&>*]:shrink-0 [&>*]:whitespace-nowrap">
              <TabsTrigger value="props">Properties</TabsTrigger>
              <TabsTrigger value="pins">Pins</TabsTrigger>
              <TabsTrigger value="meta">Details</TabsTrigger>
              <TabsTrigger value="check" className="flex items-center gap-1">
                Check
                {issues.length > 0 && <span className={cn("rounded-full px-1 text-[10px] font-semibold text-white", errors.length ? "bg-danger" : "bg-warning")}>{issues.length}</span>}
              </TabsTrigger>
              <TabsTrigger value="docs">Docs</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="props" className="min-h-0 flex-1 overflow-auto">
              <Inspector readOnly={readOnly} />
            </TabsContent>
            <TabsContent value="pins" className="min-h-0 flex-1 overflow-hidden">
              <PinTable readOnly={readOnly} />
            </TabsContent>
            <TabsContent value="meta" className="min-h-0 flex-1 overflow-auto">
              <MetadataForm readOnly={readOnly} categories={categories} />
            </TabsContent>
            <TabsContent value="check" className="min-h-0 flex-1 overflow-auto">
              <ValidationList issues={issues} readOnly={readOnly} />
            </TabsContent>
            <TabsContent value="docs" className="min-h-0 flex-1 overflow-auto p-3">
              <p className="mb-2 text-2xs text-muted">Datasheets, spec sheets, manuals and certificates for this part. Every drawing that uses this element shows them in the component's Documents section.</p>
              <PartDocuments target={{ scope: "LIBRARY", libraryElementId: detail.id }} partNumber={metaPart.partNumber || undefined} manufacturer={metaPart.manufacturer || undefined} onError={(m) => toast.error(m)} />
            </TabsContent>
            <TabsContent value="history" className="min-h-0 flex-1 overflow-auto">
              <RevisionsPanel
                id={detail.id}
                current={detail.revision}
                approved={detail.approvedRevision}
                canRestore={!readOnly}
                dirty={dirty}
                refreshKey={revKey}
                onRestored={() => {
                  load(false);
                  setRevKey((x) => x + 1);
                }}
              />
            </TabsContent>
          </TabsRoot>
        </aside>
      </div>
      {saveOpen && (
        <SaveDialog
          detail={detail}
          base={base}
          issues={issues}
          onClose={() => setSaveOpen(false)}
          onShowIssues={() => {
            setSaveOpen(false);
            setTab("check");
          }}
          onSaved={(f) => {
            setSaveOpen(false);
            useEd.setState({ baseFrame: f });
            load(true);
            setRevKey((x) => x + 1);
          }}
        />
      )}
      <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OptionsBar({ readOnly, canvasApi }: { readOnly: boolean; canvasApi: React.RefObject<CanvasApi | null> }) {
  const st = useEd();
  const canUndo = st.past.length > 0, canRedo = st.future.length > 0;
  const hasSel = st.sel.length > 0;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap border-b border-border bg-panel px-2 text-2xs [scrollbar-width:none] [&>*]:shrink-0" role="toolbar" aria-label="Canvas options">
      {!readOnly && (
        <>
          <Button size="icon-sm" variant="ghost" disabled={!canUndo} onClick={st.undo} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={!canRedo} onClick={st.redo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 />
          </Button>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button size="icon-sm" variant="ghost" disabled={!hasSel} onClick={() => rotateSelection(1)} aria-label="Rotate selection" title="Rotate 90° (Ctrl+R)">
            <RotateCw />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={!hasSel} onClick={() => mirrorSelection("h")} aria-label="Mirror horizontally" title="Mirror horizontally (Ctrl+M)">
            <FlipHorizontal2 />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={!hasSel} onClick={() => mirrorSelection("v")} aria-label="Mirror vertically" title="Mirror vertically (Ctrl+Shift+M)">
            <FlipVertical2 />
          </Button>
          <span className="mx-1 h-4 w-px bg-border" />
        </>
      )}
      {/* tool-specific options */}
      {st.tool === "polygon" && (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={st.toolOpts.polyClosed} onChange={(e) => st.setToolOpts({ polyClosed: e.target.checked })} /> Closed shape
        </label>
      )}
      {st.tool === "dyntext" && (
        <label className="flex items-center gap-1.5">
          Shows
          <select value={st.toolOpts.dynSource} onChange={(e) => st.setToolOpts({ dynSource: e.target.value })} className="h-6 rounded border border-border bg-panel px-1">
            {INFO_KEYS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
            <option value="__user">Fixed text</option>
          </select>
        </label>
      )}
      {st.tool === "pin" && (
        <div className="flex items-center gap-1.5">
          <span>Direction</span>
          <div className="w-44">
            <Seg
              label=""
              value={(st.toolOpts.pinOrient ?? "auto") as "auto" | "n" | "e" | "s" | "w"}
              options={[
                { v: "auto", l: "Auto" },
                { v: "n", l: <ArrowUp />, title: "Up" },
                { v: "e", l: <ArrowRight />, title: "Right" },
                { v: "s", l: <ArrowDown />, title: "Down" },
                { v: "w", l: <ArrowLeft />, title: "Left" },
              ]}
              onChange={(v) => st.setToolOpts({ pinOrient: v === "auto" ? null : v })}
            />
          </div>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
        <span className="tabular w-24 text-right text-subtle" aria-live="off">
          {st.cursor ? `x ${st.cursor.x}  y ${st.cursor.y}` : ""}
        </span>
        <span className="mx-1 h-4 w-px bg-border" />
        <label className="flex items-center gap-1" title="Grid step (scene units)">
          <Grid3x3 className="size-3.5 text-subtle" />
          <select value={st.grid} onChange={(e) => st.set({ grid: Number(e.target.value) })} className="h-6 rounded border border-border bg-panel px-1" aria-label="Grid step">
            {[1, 2, 5, 10].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <Button size="icon-sm" variant="tool" active={st.snap} onClick={() => st.set({ snap: !st.snap })} aria-label="Snap to grid" aria-pressed={st.snap} title="Snap to grid (hold Alt to disable temporarily)">
          <Magnet />
        </Button>
        <Button size="icon-sm" variant="tool" active={st.showGrid} onClick={() => st.set({ showGrid: !st.showGrid })} aria-label="Show grid" aria-pressed={st.showGrid} title="Show grid (G)">
          <Grid3x3 />
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button size="icon-sm" variant="ghost" onClick={() => canvasApi.current?.zoom(0.8)} aria-label="Zoom out" title="Zoom out (−)">
          <Minus />
        </Button>
        <span className="tabular w-10 text-center">{st.zoomPct}%</span>
        <Button size="icon-sm" variant="ghost" onClick={() => canvasApi.current?.zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)">
          <Plus />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => canvasApi.current?.fit()} aria-label="Zoom to fit" title="Zoom to fit (F)">
          <Maximize />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SaveDialog({ detail, base, issues, onClose, onSaved, onShowIssues }: { detail: ElementDetail; base: ElementDef; issues: ReturnType<typeof useIssues>; onClose: () => void; onSaved: (f: Frame) => void; onShowIssues: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const dirty = useEd((s) => isDirty(s));
  const willReapprove = detail.visibility === "ORG" && (detail.status === "APPROVED" || detail.status === "PUBLISHED");

  const build = useMemo(
    () => () => {
      const st = useEd.getState();
      const doc = st.doc;
      const m = st.meta;
      const info = { ...doc.info };
      const setInfo = (k: string, v: string) => {
        if (v.trim()) info[k] = v.trim();
        else if (k in info && !base.info[k]) delete info[k];
      };
      setInfo("manufacturer", m.manufacturer);
      setInfo("manufacturer_reference", m.partNumber);
      setInfo("function", m.function);
      const pins: PinDef[] = doc.pins.map((p) => {
        const { required: _r, ...rest } = p;
        void _r;
        return rest;
      });
      const def = finalizeDef({
        ...base,
        names: Object.fromEntries(Object.entries(doc.names).filter(([k, v]) => k === "en" || v.trim())),
        linkType: doc.linkType,
        kind: doc.kind,
        info,
        prims: doc.prims.map(stripId),
        pins,
        meta: { ...base.meta, informations: doc.informations },
        xml: base.xml,
      }, base);
      const content = serializeElmt(def);
      const metaOut: Record<string, string> = { ...m.extra };
      if (m.manufacturer.trim()) metaOut.manufacturer = m.manufacturer.trim();
      if (m.partNumber.trim()) metaOut.partNumber = m.partNumber.trim();
      if (m.function.trim()) metaOut.function = m.function.trim();
      const req = doc.pins.filter((p) => p.required).map((p) => p.id);
      if (req.length) metaOut.requiredPins = req.join(",");
      return {
        frame: { width: def.width, height: def.height, hotspotX: def.hotspotX, hotspotY: def.hotspotY },
        content,
        name: (doc.names.en || detail.name).trim(),
        category: m.category,
        prefix: m.prefix.trim(),
        description: m.description,
        tags: m.tags,
        meta: metaOut,
        license: m.license || null,
        attribution: m.attribution || null,
        source: m.source || null,
      };
    },
    [base, detail.name],
  );

  const save = async () => {
    setBusy(true);
    try {
      const { frame, ...payload } = build();
      // round-trip self check: the serialized file must parse back
      const back = parseElmt(payload.content);
      if (back.pins.length !== useEd.getState().doc.pins.length) throw new Error("Internal check failed: pins lost during serialisation");
      const j = await api<{ revision: number; status: string }>(`/api/library/elements/${detail.id}`, { method: "PUT", json: { ...payload, note: note.trim() || undefined, baseRevision: detail.revision } });
      useEd.getState().markSaved();
      toast.success(j.revision !== detail.revision ? `Saved revision ${j.revision}${j.status === "PENDING_APPROVAL" && detail.status !== "PENDING_APPROVAL" ? " — sent for re-approval" : ""}` : "Details saved");
      onSaved(frame);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Save revision" description={`Current: revision ${detail.revision}. Changing the drawing creates revision ${detail.revision + 1}; history is kept.`}>
        {errors.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-danger">Fix these problems before saving:</p>
            <ul className="list-disc space-y-1 pl-4 text-2xs text-danger">
              {errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={onShowIssues}>
                Show problems
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            {!dirty && <p className="text-2xs text-subtle">No changes since the last save.</p>}
            {warnings.length > 0 && (
              <div className="rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-2xs text-warning">
                <p className="font-medium">
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {warnings.slice(0, 5).map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {willReapprove && (
              <p className="rounded-md border border-border bg-panel-2 px-3 py-2 text-2xs text-muted">This element is used organization-wide. If your role requires approval, the new revision is sent to approvers and others keep using the approved one until then.</p>
            )}
            <Field label="What changed? (optional)">
              <Textarea autoFocus rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Added PE pin, fixed pin 3 direction" onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && save()} />
            </Field>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} disabled={busy || !dirty}>
                {busy ? <Loader2 className="animate-spin" /> : <Save />} Save revision
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: [string, string][] = [
    ...TOOLS.map((t) => [t.key, t.label] as [string, string]),
    ["Ctrl Z / Ctrl ⇧ Z", "Undo / redo"],
    ["Ctrl C / X / V", "Copy / cut / paste"],
    ["Ctrl D", "Duplicate selection"],
    ["Ctrl A", "Select all"],
    ["Del", "Delete selection"],
    ["Arrows (⇧ ×10)", "Move selection by one grid step"],
    ["Ctrl R (⇧ reverse)", "Rotate selection 90°"],
    ["Ctrl M / Ctrl ⇧ M", "Mirror horizontally / vertically"],
    ["Ctrl ] / Ctrl [", "Bring forward / send backward (⇧: front/back)"],
    ["R (pin tool)", "Turn the pin direction"],
    ["Alt (while dragging)", "Temporarily disable snapping"],
    ["Shift (while drawing)", "Square / circle / 45° lines"],
    ["Space + drag, middle mouse", "Pan"],
    ["Wheel, + / −", "Zoom"],
    ["F", "Zoom to fit"],
    ["G", "Toggle grid"],
    ["Ctrl S", "Save revision"],
    ["Esc", "Cancel / back to select"],
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Keyboard shortcuts" wide>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          {rows.map(([k, l]) => (
            <div key={k + l} className="flex items-center justify-between gap-3 border-b border-border py-1">
              <span className="text-muted">{l}</span>
              <Kbd>{k}</Kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
