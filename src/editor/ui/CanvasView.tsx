"use client";
import { useEffect, useRef, useState } from "react";
import {
  MousePointer2,
  Spline,
  Type,
  Hand,
  MessageSquarePlus,
  RotateCw,
  FlipHorizontal2,
  Trash2,
  Copy,
  Lock,
  Magnet,
  Grid3x3,
  Map as MapIcon,
  Plus,
  Minus,
  Maximize,
  Network,
  Boxes,
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
  Scissors,
  ClipboardPaste,
  Layers,
  RotateCcw,
  Eraser,
  ChevronDown,
} from "lucide-react";
import { Engine } from "../engine/Engine";
import { toast } from "sonner";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { runCommand } from "./commands";
import { Button } from "@/components/ui/button";
import { Tip, Popover, PopoverContent, PopoverTrigger, Switch } from "@/components/ui/misc";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import { getPage, selSize } from "@/core/ops";
import { cn } from "@/lib/utils";
import type { Rect } from "@/core/model";
import { PageTabs } from "./PageTabs";

type EditState = { kind: "free" | "element"; id: string; textId?: string; info?: string | null; value: string; rect: Rect; size: number } | null;

export function CanvasView() {
  const host = useRef<HTMLDivElement>(null);
  const hostB = useRef<HTMLDivElement>(null);
  const ui = useEditorUI();
  const [edit, setEdit] = useState<EditState>(null);
  const [fps, setFps] = useState(0);
  const [minimap, setMinimap] = useState(true);
  const diffMode = useEditor((s) => s.diff?.mode);
  const newCommentRef = useRef<(a: unknown) => void>(() => {});

  useEffect(() => {
    if (!host.current) return;
    const eng = new Engine(host.current, useEditor, {
      onEditText: (t) => setEdit(t),
      onAnnounce: (m) => ui.announce(m),
      onToast: (m, undo) => ui.toast(m, { undo }),
      onFps: (f) => setFps(f),
      onFollow: (f) => {
        toast(`${f.label}`, {
          description: f.count > 2 ? `${f.index} of ${f.count} — follow again for the next` : undefined,
          action: { label: "Back", onClick: () => ui.engine.current?.goBack() },
          duration: 4000,
        });
      },
      onNewComment: (a) => {
        const s = useEditor.getState();
        s.set("pendingComment", { pageId: a.pageId, anchor: a.anchor });
        s.set("panels", { ...s.panels, right: "review" });
        s.setTool("select");
      },
    });
    ui.engine.current = eng;
    (window as unknown as { __voltEngine?: Engine }).__voltEngine = eng;
    return () => {
      eng.destroy();
      ui.engine.current = null;
    };
  }, [ui]);

  // side-by-side compare: secondary engine that mirrors the primary viewport
  useEffect(() => {
    if (diffMode !== "side" || !hostB.current) return;
    const eng2 = new Engine(hostB.current, useEditor, {}, { secondary: true });
    const primary = ui.engine.current;
    const sync = () => primary && eng2.syncFrom(primary);
    primary?.viewListeners.add(sync);
    requestAnimationFrame(sync);
    return () => {
      primary?.viewListeners.delete(sync);
      eng2.destroy();
    };
  }, [diffMode, ui]);

  void newCommentRef;

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="relative flex min-h-0 flex-1">
        {diffMode === "side" && (
          <div className="relative min-w-0 flex-1 border-r border-border">
            <div ref={hostB} className="absolute inset-0 bg-canvas" />
            <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-panel/90 px-2 py-1 text-2xs font-medium text-muted shadow-float">Compared version (read-only)</div>
          </div>
        )}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="relative min-w-0 flex-1">
              <div ref={host} className="absolute inset-0 bg-canvas data-[focus=1]:ring-2 data-[focus=1]:ring-inset data-[focus=1]:ring-accent/40" data-testid="canvas-host" />
              <ToolRail />
              <SelectionBar />
              <ZoomControls fps={fps} minimap={minimap} setMinimap={setMinimap} />
              {minimap && <Minimap />}
              {edit && <InlineEditor state={edit} onDone={() => setEdit(null)} />}
            </div>
          </ContextMenuTrigger>
          <CanvasContextMenu />
        </ContextMenu>
      </div>
      <PageTabs />
    </div>
  );
}

function ToolRail() {
  const tool = useEditor((s) => s.tool);
  const editable = useEditor((s) => !!s.version?.editable);
  const canComment = useEditor((s) => !!s.version?.canComment);
  const set = useEditor((s) => s.setTool);
  const tools = [
    { id: "select", icon: <MousePointer2 />, label: "Select", key: "V", on: true },
    { id: "wire", icon: <Spline />, label: "Wire", key: "W", on: editable },
    { id: "text", icon: <Type />, label: "Text", key: "T", on: editable },
    { id: "pan", icon: <Hand />, label: "Pan", key: "H / Space", on: true },
    { id: "comment", icon: <MessageSquarePlus />, label: "Comment", key: "C", on: canComment },
  ] as const;
  return (
    <div className="absolute left-3 top-3 z-10 flex flex-col gap-0.5 rounded-lg border border-border bg-panel/95 p-1 shadow-float backdrop-blur" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {tools
        .filter((t) => t.on)
        .map((t) => (
          <Tip key={t.id} content={t.label} shortcut={t.key} side="right">
            <Button variant="tool" size="icon" active={tool === t.id} aria-pressed={tool === t.id} aria-label={t.label} onClick={() => set(t.id)}>
              {t.icon}
            </Button>
          </Tip>
        ))}
    </div>
  );
}

function SelectionBar() {
  const sel = useEditor((s) => s.sel);
  const editable = useEditor((s) => !!s.version?.editable);
  const tool = useEditor((s) => s.tool);
  const place = useEditor((s) => s.place);
  const ui = useEditorUI();
  const n = selSize(sel);
  const run = (id: string) => runCommand(id, ui);
  if (tool === "wire")
    return (
      <Hint>
        Click a pin or wire to start · click to add corners · finish on a pin, junction or wire · <b>Space</b> flips bend · <b>Enter</b>/double-click ends dangling · <b>Alt</b> disables snapping
      </Hint>
    );
  if (tool === "place" && place)
    return (
      <Hint>
        Click to place (repeatable) · <b>R</b> rotate · <b>X</b> mirror · <b>Esc</b> done
      </Hint>
    );
  if (tool === "comment") return <Hint>Click on an element, wire or anywhere to leave a comment</Hint>;
  if (!n || !editable) return null;
  const B = ({ id, icon, label }: { id: string; icon: React.ReactNode; label: string }) => (
    <Tip content={label}>
      <Button variant="ghost" size="icon" aria-label={label} onClick={() => run(id)}>
        {icon}
      </Button>
    </Tip>
  );
  return (
    <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-panel/95 p-1 shadow-pop backdrop-blur animate-in" role="toolbar" aria-label="Selection actions">
      <span className="px-2 text-2xs font-medium text-muted tabular">{n} selected</span>
      <div className="mx-0.5 h-4 w-px bg-border" />
      {sel.elements.length > 0 && (
        <>
          <B id="rotate" icon={<RotateCw />} label="Rotate (R)" />
          <B id="mirror" icon={<FlipHorizontal2 />} label="Mirror (X)" />
        </>
      )}
      {sel.elements.length > 1 && (
        <>
          <B id="align-center" icon={<AlignHorizontalJustifyCenter />} label="Align centers horizontally" />
          <B id="align-middle" icon={<AlignVerticalJustifyCenter />} label="Align centers vertically" />
        </>
      )}
      <B id="selectNet" icon={<Network />} label="Select connected net (N)" />
      <B id="duplicate" icon={<Copy />} label="Duplicate (⌘D)" />
      {sel.elements.length > 0 && <B id="lock" icon={<Lock />} label="Lock / unlock (⌘L)" />}
      {sel.elements.length > 0 && <B id="block" icon={<Boxes />} label="Create reusable block" />}
      <div className="mx-0.5 h-4 w-px bg-border" />
      <B id="delete" icon={<Trash2 className="text-danger" />} label="Delete (Del)" />
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-lg bg-fg/90 px-3 py-1.5 text-2xs text-bg shadow-pop [&_b]:font-semibold">{children}</div>;
}

function ZoomControls({ fps, minimap, setMinimap }: { fps: number; minimap: boolean; setMinimap: (v: boolean) => void }) {
  const zoom = useEditor((s) => s.zoom);
  const cursor = useEditor((s) => s.cursor);
  const grid = useEditor((s) => s.gridVisible);
  const snap = useEditor((s) => s.snapSettings);
  const ui = useEditorUI();
  const run = (id: string) => runCommand(id, ui);
  const toggle = (k: keyof typeof snap) => useEditor.getState().set("snapSettings", { ...snap, [k]: !snap[k] });
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1">
      <div className="hidden items-center gap-2 rounded-md bg-panel/90 px-2 py-1 font-mono text-[10px] text-subtle shadow-float tabular sm:flex">
        {cursor ? `${Math.round(cursor.x)}, ${Math.round(cursor.y)}` : "—"}
        {fps > 0 && <span title="Render budget (frames per second the renderer can sustain)">{fps} fps</span>}
      </div>
      <div className="flex items-center rounded-lg border border-border bg-panel/95 p-0.5 shadow-float backdrop-blur">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs" aria-label="Snapping settings" className="gap-1">
              <Magnet /> <ChevronDown className="!size-2.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60">
            <p className="mb-2 text-xs font-semibold">Snapping</p>
            {(
              [
                ["pins", "Element pins"],
                ["junctions", "Junctions & wire ends"],
                ["wires", "Existing wires (creates junction)"],
                ["guides", "Alignment guides"],
                ["grid", "Grid"],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="flex h-7 items-center justify-between text-xs">
                {l}
                <Switch checked={snap[k]} onCheckedChange={() => toggle(k)} />
              </label>
            ))}
            <p className="mt-2 text-2xs text-subtle">Priority: {snap.order.join(" → ")}. Hold Alt to place freely.</p>
            <PriorityEditor />
          </PopoverContent>
        </Popover>
        <Tip content="Grid" shortcut="G">
          <Button variant="tool" size="icon-sm" active={grid} aria-label="Toggle grid" onClick={() => run("grid")}>
            <Grid3x3 />
          </Button>
        </Tip>
        <Tip content="Minimap">
          <Button variant="tool" size="icon-sm" active={minimap} aria-label="Toggle minimap" onClick={() => setMinimap(!minimap)}>
            <MapIcon />
          </Button>
        </Tip>
        <div className="mx-0.5 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => run("zoomOut")}>
          <Minus />
        </Button>
        <button className="w-11 text-center text-2xs font-medium tabular text-muted hover:text-fg" onClick={() => run("zoom100")} title="Zoom to 100%">
          {Math.round(zoom * 100)}%
        </button>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => run("zoomIn")}>
          <Plus />
        </Button>
        <Tip content="Fit" shortcut="F">
          <Button variant="ghost" size="icon-sm" aria-label="Zoom to fit" onClick={() => run("fit")}>
            <Maximize />
          </Button>
        </Tip>
      </div>
    </div>
  );
}

function PriorityEditor() {
  const snap = useEditor((s) => s.snapSettings);
  const move = (i: number, d: number) => {
    const o = [...snap.order];
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    useEditor.getState().set("snapSettings", { ...snap, order: o });
  };
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {snap.order.map((k, i) => (
        <span key={k} className="inline-flex items-center gap-0.5 rounded border border-border bg-panel-2 px-1 text-2xs">
          <button aria-label={`Raise ${k} priority`} className="text-subtle hover:text-fg" onClick={() => move(i, -1)}>
            ‹
          </button>
          {k}
          <button aria-label={`Lower ${k} priority`} className="text-subtle hover:text-fg" onClick={() => move(i, 1)}>
            ›
          </button>
        </span>
      ))}
    </div>
  );
}

function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const ui = useEditorUI();
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const [xf, setXf] = useState<{ s: number; ox: number; oy: number } | null>(null);
  const [vp, setVp] = useState<Rect | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const eng = ui.engine.current;
      if (eng && ref.current) setXf(eng.renderThumbnail(ref.current));
    }, 250);
    return () => clearTimeout(t);
  }, [doc, pageId, ui]);
  useEffect(() => {
    const eng = ui.engine.current;
    if (!eng) return;
    const upd = () => setVp(eng.worldViewport());
    upd();
    eng.viewListeners.add(upd);
    return () => void eng.viewListeners.delete(upd);
  }, [ui, xf]);
  const W = 180, H = 120;
  const go = (e: React.PointerEvent) => {
    if (!xf || !(e.buttons & 1)) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - r.left) * 2 - xf.ox) / xf.s;
    const y = ((e.clientY - r.top) * 2 - xf.oy) / xf.s;
    const eng = ui.engine.current;
    if (eng) eng.centerOn({ x, y }, eng.view.s);
  };
  return (
    <div
      className="absolute bottom-12 right-3 z-10 overflow-hidden rounded-lg border border-border bg-panel shadow-float"
      style={{ width: W, height: H }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        go(e);
      }}
      onPointerMove={go}
      aria-label="Minimap"
      role="img"
    >
      <canvas ref={ref} width={W * 2} height={H * 2} style={{ width: W, height: H }} />
      {xf && vp && (
        <div
          className="pointer-events-none absolute border-2 border-accent/70 bg-accent/5"
          style={{ left: (vp.x * xf.s + xf.ox) / 2, top: (vp.y * xf.s + xf.oy) / 2, width: (vp.w * xf.s) / 2, height: (vp.h * xf.s) / 2 }}
        />
      )}
    </div>
  );
}

function InlineEditor({ state, onDone }: { state: NonNullable<EditState>; onDone: () => void }) {
  const [v, setV] = useState(state.value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const s = useEditor.getState();
    if (v !== state.value) {
      if (state.id.startsWith("wire:")) {
        const wid = state.id.slice(5);
        s.apply("Edit wire label", (d) => {
          const w = getPage(d, s.pageId).wires.find((x) => x.id === wid);
          if (w) w.label = v.trim() || undefined;
        });
      } else if (state.kind === "free") {
        s.apply("Edit text", (d) => {
          const t = getPage(d, s.pageId).texts.find((x) => x.id === state.id);
          if (t) t.text = v;
        });
      } else {
        s.apply("Edit label", (d) => {
          const e = getPage(d, s.pageId).elements.find((x) => x.id === state.id);
          if (!e) return;
          if (state.info) {
            e.info[state.info] = v;
            if (state.info === "label") e.refLocked = true;
          } else {
            const t = e.texts.find((x) => x.id === state.textId);
            if (t) t.text = v;
          }
        });
      }
    }
    onDone();
  };
  return (
    <textarea
      ref={ref}
      value={v}
      rows={Math.max(1, v.split("\n").length)}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone();
        if (e.key === "Enter" && (!e.shiftKey || state.kind === "element")) {
          e.preventDefault();
          commit();
        }
        e.stopPropagation();
      }}
      className="absolute z-20 resize-none rounded border border-accent bg-panel px-1 font-sans text-fg shadow-pop outline-none ring-2 ring-accent/20"
      style={{ left: state.rect.x - 3, top: state.rect.y - 3, minWidth: Math.max(80, state.rect.w), fontSize: state.size, lineHeight: 1.25 }}
      aria-label="Edit text"
    />
  );
}

function CanvasContextMenu() {
  const sel = useEditor((s) => s.sel);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const n = selSize(sel);
  const run = (id: string) => runCommand(id, ui);
  const I = ({ id, icon, label, keys, danger }: { id: string; icon?: React.ReactNode; label: string; keys?: string; danger?: boolean }) => (
    <ContextMenuItem onSelect={() => run(id)} shortcut={keys} danger={danger}>
      {icon}
      {label}
    </ContextMenuItem>
  );
  return (
    <ContextMenuContent className={cn("w-56")}>
      {n > 0 ? (
        <>
          {editable && <I id="cut" icon={<Scissors />} label="Cut" keys="⌘X" />}
          <I id="copy" icon={<Copy />} label="Copy" keys="⌘C" />
          {editable && <I id="duplicate" icon={<Copy />} label="Duplicate" keys="⌘D" />}
          <ContextMenuSeparator />
          {sel.elements.length > 0 && editable && (
            <>
              <I id="rotate" icon={<RotateCw />} label="Rotate clockwise" keys="R" />
              <I id="rotateCcw" icon={<RotateCcw />} label="Rotate counter-clockwise" keys="⇧R" />
              <I id="mirror" icon={<FlipHorizontal2 />} label="Mirror" keys="X" />
              <I id="resetText" icon={<Type />} label="Restore default label placement" />
              <I id="resetOverrides" icon={<Eraser />} label="Reset style overrides" />
              <I id="lock" icon={<Lock />} label="Lock / unlock" keys="⌘L" />
              <ContextMenuSeparator />
            </>
          )}
          <I id="selectNet" icon={<Network />} label="Select connected net" keys="N" />
          <I id="zoomSel" icon={<Maximize />} label="Zoom to selection" keys="Z" />
          {sel.elements.length === 1 && <I id="selectSame" icon={<Layers />} label="Select all of this type" />}
          {sel.elements.length > 0 && editable && <I id="block" icon={<Boxes />} label="Create reusable block…" />}
          {sel.elements.length > 0 && <I id="createElement" icon={<Boxes />} label="Create element from selection…" />}
          {editable && (
            <>
              <ContextMenuSeparator />
              <I id="delete" icon={<Trash2 />} label="Delete" keys="Del" danger />
            </>
          )}
        </>
      ) : (
        <>
          {editable && <I id="paste" icon={<ClipboardPaste />} label="Paste here" keys="⌘V" />}
          <I id="selectAll" label="Select all" keys="⌘A" />
          <ContextMenuSeparator />
          <I id="fit" icon={<Maximize />} label="Zoom to fit" keys="F" />
          <I id="fitPage" label="Zoom to page" keys="⇧F" />
          {editable && (
            <>
              <ContextMenuSeparator />
              <I id="connect" icon={<Spline />} label="Connect pins…" keys="⇧W" />
              <I id="pageSettings" label="Page settings…" />
            </>
          )}
        </>
      )}
    </ContextMenuContent>
  );
}
