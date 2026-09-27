"use client";
import * as D from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { X, RotateCcw, Building2, Type, Spline, Square } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import type { GraphicStyles, PartialStyles, Styles, TextRole, TextStyle, DeepPartial } from "@/core/model";
import { DEFAULT_FRAME } from "@/core/render/scene";
import { TEXT_ROLES, COMPONENT_INFO, type InfoPlacement } from "@/core/model";
import { ROLE_LABELS, deepMerge, projectStyles } from "@/core/styles";
import { Button } from "@/components/ui/button";
import { Checkbox, Switch, Badge } from "@/components/ui/misc";
import { NativeSelect } from "@/components/ui/input";
import { Row, Commit, ColorInput } from "../Inspector";
import { StylePicker } from "../StylePicker";
import { cn } from "@/lib/utils";

type Sel = { kind: "text"; role: TextRole } | { kind: "graphics"; key: keyof GraphicStyles };

const SAMPLE: Partial<Record<TextRole, string>> = { pinNumber: "13", componentRef: "K12", wireLabel: "L1-24", componentName: "2-pole MCB", componentRating: "16 A, 400 V", componentPartNumber: "A9F74216", componentManufacturer: "Schneider Electric", wireInfo: "BK 1.5 mm²" };

const GRAPHIC_LABELS: Partial<Record<keyof GraphicStyles, string>> = { componentInfo: "Component info", wire: "Wires & junctions", bus: "Buses", pin: "Pins", outline: "Symbol lines", frame: "Component outline", border: "Page border", titleBlock: "Title block", review: "Review markup" };

export function StylesDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const [draft, setDraft] = useState<PartialStyles>({});
  const [sel, setSel] = useState<Sel>({ kind: "text", role: "componentRef" });
  const [resetOv, setResetOv] = useState(true);
  const current = useMemo(() => projectStyles(doc.baseStyles, doc.styles), [doc.baseStyles, doc.styles]);
  const eff: Styles = useMemo(() => deepMerge(current, draft as DeepPartial<Styles>), [current, draft]);

  // live preview on the canvas
  useEffect(() => {
    useEditor.getState().set("previewStyles", Object.keys(draft).length ? deepMerge(doc.styles as Styles, draft as DeepPartial<Styles>) as PartialStyles : null);
  }, [draft, doc.styles]);
  useEffect(() => () => useEditor.getState().set("previewStyles", null), []);

  const setText = (role: TextRole, patch: Partial<TextStyle>) => setDraft((d) => ({ ...d, text: { ...(d.text ?? {}), [role]: { ...(d.text?.[role] ?? {}), ...patch } } }));
  const setG = <K extends keyof GraphicStyles>(key: K, patch: DeepPartial<GraphicStyles[K]>) => setDraft((d) => ({ ...d, graphics: { ...(d.graphics ?? {}), [key]: { ...((d.graphics?.[key] as object) ?? {}), ...(patch as object) } } }));

  // impact analysis
  const impact = useMemo(() => {
    const roles = new Set(Object.keys(draft.text ?? {}) as TextRole[]);
    let objects = 0, overrides = 0;
    for (const p of doc.pages) {
      for (const e of p.elements)
        for (const t of e.texts)
          if (roles.has(t.role)) {
            objects++;
            if (t.override && Object.keys(draft.text?.[t.role] ?? {}).some((k) => k in (t.override ?? {}))) overrides++;
          }
      for (const t of p.texts)
        if (roles.has(t.role)) {
          objects++;
          if (t.override && Object.keys(draft.text?.[t.role] ?? {}).some((k) => k in (t.override ?? {}))) overrides++;
        }
      if (draft.graphics?.wire) {
        objects += p.wires.length;
        overrides += p.wires.filter((w) => w.override && Object.keys(draft.graphics!.wire!).some((k) => k in w.override!)).length;
      }
    }
    return { objects, overrides };
  }, [draft, doc.pages]);

  const apply = () => {
    const s = useEditor.getState();
    const changedText = draft.text ?? {};
    s.apply("Change global styles", (d) => {
      d.styles = deepMerge(d.styles as Styles, draft as DeepPartial<Styles>) as PartialStyles;
      if (resetOv) {
        for (const p of d.pages) {
          const clean = (o: Partial<TextStyle> | undefined, role: TextRole) => {
            if (!o) return o;
            const keys = Object.keys(changedText[role] ?? {});
            for (const k of keys) delete (o as Record<string, unknown>)[k];
            return Object.keys(o).length ? o : undefined;
          };
          for (const e of p.elements) for (const t of e.texts) if (changedText[t.role]) t.override = clean(t.override, t.role);
          for (const t of p.texts) if (changedText[t.role]) t.override = clean(t.override, t.role);
          if (draft.graphics?.wire)
            for (const w of p.wires)
              if (w.override) {
                for (const k of Object.keys(draft.graphics.wire)) delete (w.override as Record<string, unknown>)[k];
                if (!Object.keys(w.override).length) w.override = undefined;
              }
        }
      }
    });
    setDraft({});
    ui.toast("Styles applied", { undo: true });
  };

  const resetProject = () => {
    useEditor.getState().apply("Reset project styles", (d) => {
      d.styles = {};
    });
    setDraft({});
  };



  const projOverride = (role: TextRole, k: keyof TextStyle) => doc.styles.text?.[role]?.[k] !== undefined || draft.text?.[role]?.[k] !== undefined;
  const t = sel.kind === "text" ? eff.text[sel.role] : null;
  const dirty = Object.keys(draft).length > 0;

  return (
    <D.Root open modal={false} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Content
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed bottom-3 right-14 top-14 z-40 flex w-[560px] max-w-[calc(100vw-80px)] flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-pop animate-in"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <D.Title className="text-sm font-semibold">Global styles</D.Title>
              <p className="text-2xs text-muted">Project-wide defaults. Changes preview live on the canvas before you apply.</p>
            </div>
            <D.Close className="rounded p-1 text-subtle hover:bg-hover" aria-label="Close">
              <X className="size-3.5" />
            </D.Close>
          </div>
          <div className="flex items-center gap-2 border-b border-border bg-panel-2 px-4 py-2 text-2xs text-muted">
            <Building2 className="size-3" />
            <span className="shrink-0">Style template</span>
            <StylePicker className="w-56" />
            <span className="text-subtle">→ project → element → object</span>
          </div>
          <div className="flex min-h-0 flex-1">
            <nav className="w-44 shrink-0 overflow-y-auto border-r border-border p-1.5">
              <p className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Text roles</p>
              {TEXT_ROLES.map((r) => (
                <button key={r} onClick={() => setSel({ kind: "text", role: r })} className={cn("flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs", sel.kind === "text" && sel.role === r ? "bg-accent-soft text-accent" : "hover:bg-hover")}>
                  <Type className="size-3 opacity-50" />
                  <span className="truncate">{ROLE_LABELS[r]}</span>
                  {(doc.styles.text?.[r] || draft.text?.[r]) && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
                </button>
              ))}
              <p className="mt-2 px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Graphics</p>
              {(Object.keys(GRAPHIC_LABELS) as (keyof GraphicStyles)[]).map((k) => (
                <button key={k} onClick={() => setSel({ kind: "graphics", key: k })} className={cn("flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs", sel.kind === "graphics" && sel.key === k ? "bg-accent-soft text-accent" : "hover:bg-hover")}>
                  {k === "wire" || k === "bus" ? <Spline className="size-3 opacity-50" /> : <Square className="size-3 opacity-50" />}
                  <span className="truncate">{GRAPHIC_LABELS[k]}</span>
                  {(doc.styles.graphics?.[k] || draft.graphics?.[k]) && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
                </button>
              ))}
            </nav>
            <div className="min-w-0 flex-1 space-y-2.5 overflow-y-auto p-4">
              {t && sel.kind === "text" && (
                <>
                  <div className="mb-3 flex h-14 items-center justify-center rounded-lg border border-border bg-white">
                    <span style={{ fontFamily: t.font, fontSize: t.size * (4 / 3) * 1.6, fontWeight: t.weight, fontStyle: t.italic ? "italic" : "normal", color: t.color, background: t.background ?? undefined }} className="px-1">
                      {SAMPLE[sel.role] ?? ROLE_LABELS[sel.role]}
                    </span>
                  </div>
                  <Row label="Visible">
                    <Switch checked={t.visible} disabled={!editable} onCheckedChange={(v) => setText(sel.role, { visible: v })} />
                  </Row>
                  <Row label={<>Font{projOverride(sel.role, "font") && <Badge tone="accent" className="ml-1 !h-3.5 !text-[9px]">project</Badge>}</>}>
                    <NativeSelect value={t.font} disabled={!editable} onChange={(e) => setText(sel.role, { font: e.target.value })}>
                      {["Inter, Helvetica, Arial, sans-serif", "Helvetica, Arial, sans-serif", "Arial, sans-serif", "DejaVu Sans, sans-serif", "Roboto, sans-serif", "ISOCPEUR, Arial, sans-serif", "Courier New, monospace", "Times New Roman, serif"].map((f) => (
                        <option key={f} value={f}>
                          {f.split(",")[0]}
                        </option>
                      ))}
                    </NativeSelect>
                  </Row>
                  <Row label="Size (pt)">
                    <Commit type="number" step={0.5} value={t.size} disabled={!editable} onCommit={(v) => setText(sel.role, { size: Math.max(2, Number(v) || t.size) })} />
                  </Row>
                  <Row label="Weight">
                    <NativeSelect value={t.weight} disabled={!editable} onChange={(e) => setText(sel.role, { weight: Number(e.target.value) })}>
                      <option value={400}>Regular</option>
                      <option value={500}>Medium</option>
                      <option value={600}>Semibold</option>
                      <option value={700}>Bold</option>
                    </NativeSelect>
                  </Row>
                  <Row label="Italic">
                    <Switch checked={t.italic} disabled={!editable} onCheckedChange={(v) => setText(sel.role, { italic: v })} />
                  </Row>
                  <Row label="Color">
                    <ColorInput value={t.color} disabled={!editable} onChange={(v) => setText(sel.role, { color: v })} />
                  </Row>
                  <Row label="Background">
                    <div className="flex items-center gap-2">
                      <Switch checked={!!t.background} disabled={!editable} onCheckedChange={(v) => setText(sel.role, { background: v ? "#ffffff" : null })} />
                      {t.background && <ColorInput value={t.background} disabled={!editable} onChange={(v) => setText(sel.role, { background: v })} />}
                    </div>
                  </Row>
                  <Row label="Alignment">
                    <NativeSelect value={t.align} disabled={!editable} onChange={(e) => setText(sel.role, { align: e.target.value as TextStyle["align"] })}>
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </NativeSelect>
                  </Row>
                  <Row label="Rotation">
                    <NativeSelect value={t.rotation} disabled={!editable} onChange={(e) => setText(sel.role, { rotation: Number(e.target.value) })}>
                      {[0, 90, 180, 270].map((r) => (
                        <option key={r} value={r}>
                          {r}°
                        </option>
                      ))}
                    </NativeSelect>
                  </Row>
                  <Row label="Offset x / y">
                    <div className="grid grid-cols-2 gap-1">
                      <Commit type="number" value={t.dx} disabled={!editable} onCommit={(v) => setText(sel.role, { dx: Number(v) || 0 })} />
                      <Commit type="number" value={t.dy} disabled={!editable} onCommit={(v) => setText(sel.role, { dy: Number(v) || 0 })} />
                    </div>
                  </Row>
                  <Row label="Line spacing">
                    <Commit type="number" step={0.05} value={t.lineHeight} disabled={!editable} onCommit={(v) => setText(sel.role, { lineHeight: Number(v) || 1.2 })} />
                  </Row>
                </>
              )}
              {sel.kind === "graphics" && <GraphicsEditor k={sel.key} g={eff.graphics} setG={setG} editable={editable} />}
            </div>
          </div>
          <div className="flex items-center gap-3 border-t border-border bg-panel-2 px-4 py-2.5">
            {dirty ? (
              <label className="flex items-center gap-2 text-2xs text-muted">
                <Checkbox checked={resetOv} onCheckedChange={(v) => setResetOv(!!v)} />
                Also reset {impact.overrides} conflicting object override{impact.overrides === 1 ? "" : "s"} ({impact.objects} objects affected)
              </label>
            ) : (
              <Button size="xs" variant="ghost" disabled={!editable || !Object.keys(doc.styles).length} onClick={resetProject}>
                <RotateCcw /> Reset project styles to base
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft({})}>
                Discard
              </Button>
              <Button size="sm" variant="primary" disabled={!dirty || !editable} onClick={apply}>
                Apply to project
              </Button>
            </div>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function GraphicsEditor({ k, g, setG, editable }: { k: keyof GraphicStyles; g: GraphicStyles; setG: <K extends keyof GraphicStyles>(key: K, patch: DeepPartial<GraphicStyles[K]>) => void; editable: boolean }) {
  const line = (key: "wire" | "bus" | "border" | "titleBlock") => {
    const v = g[key];
    return (
      <>
        <Row label="Color">
          <ColorInput value={v.color} disabled={!editable} onChange={(c) => setG(key, { color: c })} />
        </Row>
        <Row label="Thickness">
          <Commit type="number" step={0.25} value={v.width} disabled={!editable} onCommit={(x) => setG(key, { width: Math.max(0.1, Number(x) || 1) })} />
        </Row>
        <Row label="Line style">
          <NativeSelect value={v.dash} disabled={!editable} onChange={(e) => setG(key, { dash: e.target.value as "solid" })}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dashdot">Dash-dot</option>
          </NativeSelect>
        </Row>
      </>
    );
  };
  switch (k) {
    case "componentInfo": {
      const f = g.componentInfo ?? {};
      const lay = g.componentInfoLayout ?? {};
      return (
        <>
          <p className="text-2xs text-muted">Lines shown under each component by default (each component can override this in its Properties panel). Their font, size and color are the “Component …” text roles.</p>
          {COMPONENT_INFO.map((c) => (
            <Row key={c.key} label={c.name}>
              <Switch checked={!!f[c.key]} disabled={!editable} onCheckedChange={(v) => setG("componentInfo", { [c.key]: v })} />
            </Row>
          ))}
          <Row label="Placement">
            <NativeSelect value={lay.at ?? "auto"} disabled={!editable} onChange={(e) => setG("componentInfoLayout", { at: e.target.value as InfoPlacement })}>
              <option value="auto">Under reference</option>
              <option value="right">Right of symbol</option>
              <option value="left">Left of symbol</option>
              <option value="below">Below symbol</option>
            </NativeSelect>
          </Row>
          <Row label="Alignment">
            <NativeSelect value={lay.align ?? ""} disabled={!editable} onChange={(e) => setG("componentInfoLayout", { align: (e.target.value || undefined) as "left" })}>
              <option value="">Each line's own alignment</option>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </NativeSelect>
          </Row>
        </>
      );
    }
    case "wire":
      return (
        <>
          {line("wire")}
          <Row label="Junction size">
            <Commit type="number" step={0.25} value={g.wire.junctionRadius} disabled={!editable} onCommit={(x) => setG("wire", { junctionRadius: Number(x) || 2.5 })} />
          </Row>
          <Row label="Junction color">
            <ColorInput value={g.wire.junctionColor} disabled={!editable} onChange={(c) => setG("wire", { junctionColor: c })} />
          </Row>
          <Row label="Highlight">
            <ColorInput value={g.wire.highlight} disabled={!editable} onChange={(c) => setG("wire", { highlight: c })} />
          </Row>
        </>
      );
    case "bus":
      return line("bus");
    case "border":
      return (
        <>
          {line("border")}
          <Row label="Header fill">
            <ColorInput value={g.border.headerColor} disabled={!editable} onChange={(c) => setG("border", { headerColor: c })} />
          </Row>
        </>
      );
    case "titleBlock":
      return line("titleBlock");
    case "pin":
      return (
        <>
          <Row label="Point color">
            <ColorInput value={g.pin.color} disabled={!editable} onChange={(c) => setG("pin", { color: c })} />
          </Row>
          <Row label="Show points">
            <Switch checked={g.pin.showPoint} disabled={!editable} onCheckedChange={(v) => setG("pin", { showPoint: v })} />
          </Row>
          <p className="text-2xs text-subtle">Unconnected pin points are shown while editing only — never in exports.</p>
        </>
      );
    case "outline":
      return (
        <>
          <p className="text-2xs text-subtle">Colour and thickness of the symbols&apos; own lines. For a box around components, use Component outline.</p>
          <Row label="Force color">
            <div className="flex items-center gap-2">
              <Switch checked={!!g.outline.color} disabled={!editable} onCheckedChange={(v) => setG("outline", { color: v ? "#111827" : null })} />
              {g.outline.color && <ColorInput value={g.outline.color} disabled={!editable} onChange={(c) => setG("outline", { color: c })} />}
            </div>
          </Row>
          <Row label="Width scale">
            <Commit type="number" step={0.1} value={g.outline.widthScale} disabled={!editable} onCommit={(x) => setG("outline", { widthScale: Math.max(0.1, Number(x) || 1) })} />
          </Row>
        </>
      );
    case "frame": {
      const f = { ...DEFAULT_FRAME, ...(g.frame ?? {}) };
      return (
        <>
          <Row label="Show">
            <Switch checked={f.show} disabled={!editable} onCheckedChange={(v) => setG("frame", { show: v })} />
          </Row>
          <Row label="Color">
            <ColorInput value={f.color} disabled={!editable} onChange={(c) => setG("frame", { color: c })} />
          </Row>
          <Row label="Thickness">
            <Commit type="number" step={0.25} value={f.width} disabled={!editable} onCommit={(x) => setG("frame", { width: Math.max(0.1, Number(x) || 0.8) })} />
          </Row>
          <Row label="Line style">
            <NativeSelect value={f.dash} disabled={!editable} onChange={(e) => setG("frame", { dash: e.target.value as "solid" })}>
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
              <option value="dashdot">Dash-dot</option>
            </NativeSelect>
          </Row>
          <Row label="Gap">
            <Commit type="number" step={1} value={f.padding} disabled={!editable} onCommit={(x) => setG("frame", { padding: Math.max(0, Number(x) || 0) })} />
          </Row>
          <p className="text-2xs text-subtle">A box around each component&apos;s symbol. The symbol keeps its own colours; turn it on or off per component in the inspector.</p>
        </>
      );
    }
    case "review":
      return (
        <>
          {(["added", "removed", "changed", "comment"] as const).map((x) => (
            <Row key={x} label={x}>
              <ColorInput value={g.review[x]} disabled={!editable} onChange={(c) => setG("review", { [x]: c })} />
            </Row>
          ))}
        </>
      );
    default:
      return null;
  }
}
