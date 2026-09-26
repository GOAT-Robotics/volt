"use client";
import { useEffect, useMemo, useRef } from "react";
import type { Draft } from "immer";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, FlipHorizontal2, FlipVertical2, MousePointerClick, RotateCw, Trash2 } from "lucide-react";
import type { LineEnd, PinDef, Prim, PrimStyle } from "@/core/model";
import { Button } from "@/components/ui/button";
import { Switch, Kbd } from "@/components/ui/misc";
import { INFO_KEYS, PIN_TYPES } from "@/lib/library/elmt-tools";
import { useEd, defOf, type EdDoc, type EdPrim } from "./store";
import { NumField, TextField, SelectField, Swatches, Seg, LINE_STYLES, LINE_WEIGHTS, COLOR_NAMES, FILLINGS } from "./fields";
import { deleteSelection, mirrorSelection, rotateSelection } from "./actions";
import { r1 } from "./geom";

const TYPE_LABEL: Record<Prim["t"], string> = { line: "Line", rect: "Rectangle", ellipse: "Ellipse", arc: "Arc", polygon: "Polygon", text: "Text", dyntext: "Dynamic text" };
const LINE_ENDS: { v: LineEnd; l: string }[] = [
  { v: "none", l: "None" },
  { v: "simple", l: "Arrow" },
  { v: "triangle", l: "Triangle" },
  { v: "circle", l: "Circle" },
  { v: "diamond", l: "Diamond" },
];

export function Inspector({ readOnly }: { readOnly: boolean }) {
  const sel = useEd((s) => s.sel);
  const doc = useEd((s) => s.doc);
  const selSet = useMemo(() => new Set(sel), [sel]);
  const prims = doc.prims.filter((p) => selSet.has(p.id));
  const pins = doc.pins.filter((p) => selSet.has(p.id));

  if (!sel.length) return <Overview doc={doc} />;
  if (pins.length === 1 && !prims.length) return <PinInspector pin={pins[0]} readOnly={readOnly} />;
  if (prims.length === 1 && !pins.length) return <PrimInspector p={prims[0]} readOnly={readOnly} />;
  // multi
  const styled = prims.filter((p) => "style" in p) as (EdPrim & { style: PrimStyle })[];
  const first = styled[0]?.style;
  const setStyle = (k: keyof PrimStyle, v: string) =>
    useEd.getState().change((d) => {
      for (const p of d.prims) if (selSet.has(p.id) && "style" in p) (p.style as Record<string, string>)[k] = v;
    });
  return (
    <div className="space-y-3 p-3">
      <Header title={`${sel.length} items selected`} sub={`${prims.length} shapes, ${pins.length} pins`} readOnly={readOnly} />
      {first && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <SelectField label="Line style" value={first.lineStyle} options={LINE_STYLES.map((o) => ({ ...o }))} disabled={readOnly} onChange={(v) => setStyle("lineStyle", v)} />
            <SelectField label="Line weight" value={first.lineWeight} options={LINE_WEIGHTS.map((o) => ({ ...o }))} disabled={readOnly} onChange={(v) => setStyle("lineWeight", v)} />
          </div>
          <Swatches label="Line colour" value={first.color} options={COLOR_NAMES} disabled={readOnly} onChange={(v) => setStyle("color", v)} />
          <Swatches label="Fill" value={first.filling} options={FILLINGS} disabled={readOnly} onChange={(v) => setStyle("filling", v)} />
        </>
      )}
    </div>
  );
}

function Header({ title, sub, readOnly }: { title: string; sub?: string; readOnly: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs font-semibold">{title}</p>
        {sub && <p className="text-2xs text-subtle">{sub}</p>}
      </div>
      {!readOnly && (
        <div className="flex shrink-0 gap-0.5">
          <Button size="icon-sm" variant="ghost" title="Rotate 90° (Ctrl+R)" aria-label="Rotate 90 degrees" onClick={() => rotateSelection(1)}>
            <RotateCw />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Mirror horizontally (Ctrl+M)" aria-label="Mirror horizontally" onClick={() => mirrorSelection("h")}>
            <FlipHorizontal2 />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Mirror vertically (Ctrl+Shift+M)" aria-label="Mirror vertically" onClick={() => mirrorSelection("v")}>
            <FlipVertical2 />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Delete (Del)" aria-label="Delete selection" onClick={deleteSelection} className="hover:text-danger">
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  );
}

function Overview({ doc }: { doc: EdDoc }) {
  const f = defOf(doc);
  const shapes = doc.prims.filter((p) => p.t !== "text" && p.t !== "dyntext").length;
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center gap-2 text-muted">
        <MousePointerClick className="size-4" />
        <p>Select something on the canvas to edit it.</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-border bg-panel-2 p-2.5 text-2xs">
        <dt className="text-subtle">Shapes</dt>
        <dd className="tabular">{shapes}</dd>
        <dt className="text-subtle">Texts</dt>
        <dd className="tabular">{doc.prims.length - shapes}</dd>
        <dt className="text-subtle">Pins</dt>
        <dd className="tabular">{doc.pins.length}</dd>
        <dt className="text-subtle">Size (QET)</dt>
        <dd className="tabular">
          {f.width} × {f.height}
        </dd>
        <dt className="text-subtle">Hotspot</dt>
        <dd className="tabular">
          {f.hotspotX}, {f.hotspotY}
        </dd>
      </dl>
      <div className="space-y-1.5 rounded-lg border border-border p-2.5 text-2xs text-muted">
        <p className="font-medium text-fg">How to draw a symbol</p>
        <p>1. Draw the body with lines, rectangles and circles (1 square = the grid step).</p>
        <p>2. Add pins where wires connect: pick the Pin tool (<Kbd>N</Kbd>) and click at the end of a lead. The pin points away from the body automatically; press <Kbd>R</Kbd> to turn it.</p>
        <p>3. Keep the red cross (the origin) inside or near the symbol — it is the placement point.</p>
        <p>4. A “Reference” dynamic text shows the tag like K1 on diagrams.</p>
        <p>
          Pan with <Kbd>Space</Kbd>+drag or middle mouse, zoom with the wheel. <Kbd>?</Kbd> lists all shortcuts.
        </p>
      </div>
    </div>
  );
}

function useChange(id: string) {
  return (recipe: (p: Draft<EdPrim>) => void, key: string) =>
    useEd.getState().change((d) => {
      const p = d.prims.find((x) => x.id === id);
      if (p) recipe(p);
    }, `${id}:${key}`);
}

function PrimInspector({ p, readOnly }: { p: EdPrim; readOnly: boolean }) {
  const ch = useChange(p.id);
  const textRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const f = () => {
      const el = document.getElementById("symed-text-input") as HTMLInputElement | null;
      el?.focus();
      el?.select();
    };
    window.addEventListener("volt-symed:focus-text", f);
    return () => window.removeEventListener("volt-symed:focus-text", f);
  }, []);
  void textRef;
  const d = readOnly;
  const set = <K extends string>(k: K, v: unknown) => ch((q) => void ((q as unknown as Record<string, unknown>)[k] = v), k);
  const styleSet = (k: keyof PrimStyle, v: string) => ch((q) => void ("style" in q && ((q.style as Record<string, string>)[k] = v)), `style.${k}`);
  const style = "style" in p ? p.style : null;
  return (
    <div className="space-y-3 p-3">
      <Header title={TYPE_LABEL[p.t]} readOnly={readOnly} />
      {p.t === "line" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Start X" value={p.x1} disabled={d} onChange={(v) => set("x1", v)} />
            <NumField label="Start Y" value={p.y1} disabled={d} onChange={(v) => set("y1", v)} />
            <NumField label="End X" value={p.x2} disabled={d} onChange={(v) => set("x2", v)} />
            <NumField label="End Y" value={p.y2} disabled={d} onChange={(v) => set("y2", v)} />
          </div>
          <p className="text-2xs text-subtle tabular">Length {r1(Math.hypot(p.x2 - p.x1, p.y2 - p.y1))}</p>
          <div className="grid grid-cols-2 gap-2">
            <SelectField label="Start end" value={p.end1} options={LINE_ENDS} disabled={d} onChange={(v) => set("end1", v)} />
            <SelectField label="Finish end" value={p.end2} options={LINE_ENDS} disabled={d} onChange={(v) => set("end2", v)} />
            {p.end1 !== "none" && <NumField label="Start end length" value={p.len1} min={0.5} step={0.5} disabled={d} onChange={(v) => set("len1", v)} />}
            {p.end2 !== "none" && <NumField label="Finish end length" value={p.len2} min={0.5} step={0.5} disabled={d} onChange={(v) => set("len2", v)} />}
          </div>
        </>
      )}
      {(p.t === "rect" || p.t === "ellipse" || p.t === "arc") && (
        <div className="grid grid-cols-2 gap-2">
          <NumField label="X (left)" value={p.x} disabled={d} onChange={(v) => set("x", v)} />
          <NumField label="Y (top)" value={p.y} disabled={d} onChange={(v) => set("y", v)} />
          <NumField label="Width" value={p.w} min={0} disabled={d} onChange={(v) => set("w", v)} />
          <NumField label="Height" value={p.h} min={0} disabled={d} onChange={(v) => set("h", v)} />
          {p.t === "rect" && <NumField label="Corner radius X" value={p.rx} min={0} disabled={d} onChange={(v) => set("rx", v)} />}
          {p.t === "rect" && <NumField label="Corner radius Y" value={p.ry} min={0} disabled={d} onChange={(v) => set("ry", v)} />}
          {p.t === "arc" && <NumField label="Start angle" suffix="°" value={p.start} disabled={d} onChange={(v) => set("start", v)} />}
          {p.t === "arc" && <NumField label="Sweep angle" suffix="°" value={p.angle} min={-360} max={360} disabled={d} onChange={(v) => set("angle", v)} />}
        </div>
      )}
      {p.t === "arc" && <p className="text-2xs text-subtle">Angles: 0° = right, positive = counter-clockwise. Drag the round handles to adjust.</p>}
      {p.t === "polygon" && (
        <>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={p.closed} disabled={d} onCheckedChange={(v) => set("closed", v)} aria-label="Closed shape" /> Closed shape
          </label>
          <div className="max-h-44 space-y-1 overflow-auto pr-1">
            {p.pts.map((q, i) => (
              <div key={i} className="grid grid-cols-[18px_1fr_1fr] items-end gap-1.5">
                <span className="pb-1.5 text-2xs text-subtle tabular">{i + 1}</span>
                <NumField label="X" value={q.x} disabled={d} onChange={(v) => ch((x) => void (x.t === "polygon" && (x.pts[i].x = v)), `pt${i}x`)} />
                <NumField label="Y" value={q.y} disabled={d} onChange={(v) => ch((x) => void (x.t === "polygon" && (x.pts[i].y = v)), `pt${i}y`)} />
              </div>
            ))}
          </div>
        </>
      )}
      {style && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <SelectField label="Line style" value={style.lineStyle} options={LINE_STYLES.map((o) => ({ ...o }))} disabled={d} onChange={(v) => styleSet("lineStyle", v)} />
            <SelectField label="Line weight" value={style.lineWeight} options={LINE_WEIGHTS.map((o) => ({ ...o }))} disabled={d} onChange={(v) => styleSet("lineWeight", v)} />
          </div>
          <Swatches label="Line colour" value={style.color} options={COLOR_NAMES} disabled={d} onChange={(v) => styleSet("color", v)} />
          {p.t !== "line" && p.t !== "arc" && <Swatches label="Fill" value={style.filling} options={FILLINGS} disabled={d} onChange={(v) => styleSet("filling", v)} />}
        </>
      )}
      {p.t === "text" && (
        <>
          <TextField id="symed-text-input" label="Text" value={p.text} disabled={d} onChange={(v) => set("text", v)} />
          <div className="grid grid-cols-3 gap-2">
            <NumField label="X" value={p.x} disabled={d} onChange={(v) => set("x", v)} />
            <NumField label="Y (baseline)" value={p.y} disabled={d} onChange={(v) => set("y", v)} />
            <NumField label="Size" suffix="pt" value={p.size} min={1} max={72} disabled={d} onChange={(v) => set("size", v)} />
            <NumField label="Rotation" suffix="°" value={p.rotation} disabled={d} onChange={(v) => set("rotation", v)} />
            <label className="col-span-2 flex flex-col gap-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">Colour</span>
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#000000"} disabled={d} onChange={(e) => set("color", e.target.value)} className="h-7 w-full cursor-pointer rounded-md border border-border bg-panel" aria-label="Text colour" />
            </label>
          </div>
        </>
      )}
      {p.t === "dyntext" && (
        <>
          <SelectField
            label="Shows"
            value={p.from === "ElementInfo" ? p.info ?? "label" : "__user"}
            disabled={d}
            options={[...INFO_KEYS.map((k) => ({ v: k.id as string, l: k.label })), { v: "__user", l: "Fixed text (typed below)" }]}
            onChange={(v) =>
              ch((q) => {
                if (q.t !== "dyntext") return;
                if (v === "__user") {
                  q.from = "UserText";
                  delete q.info;
                  if (!q.text) q.text = "Text";
                } else {
                  q.from = "ElementInfo";
                  q.info = v;
                }
              }, "source")
            }
          />
          {p.from !== "ElementInfo" && <TextField id="symed-text-input" label="Text" value={p.text} disabled={d} onChange={(v) => set("text", v)} />}
          {p.from === "ElementInfo" && <p className="text-2xs text-subtle">Filled in per component on the diagram (e.g. the reference K1).</p>}
          <div className="grid grid-cols-3 gap-2">
            <NumField label="X" value={p.x} disabled={d} onChange={(v) => set("x", v)} />
            <NumField label="Y" value={p.y} disabled={d} onChange={(v) => set("y", v)} />
            <NumField label="Size" suffix="pt" value={p.size} min={1} max={72} disabled={d} onChange={(v) => set("size", v)} />
            <NumField label="Rotation" suffix="°" value={p.rotation} disabled={d} onChange={(v) => set("rotation", v)} />
            <NumField label="Box width" value={p.width} min={-1} disabled={d} onChange={(v) => set("width", v)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Seg label="Horizontal" value={p.halign} disabled={d} options={[{ v: "left", l: "Left" }, { v: "center", l: "Center" }, { v: "right", l: "Right" }]} onChange={(v) => set("halign", v)} />
            <Seg label="Vertical" value={p.valign} disabled={d} options={[{ v: "top", l: "Top" }, { v: "center", l: "Mid" }, { v: "bottom", l: "Bottom" }]} onChange={(v) => set("valign", v)} />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={p.frame} disabled={d} onCheckedChange={(v) => set("frame", v)} aria-label="Frame" /> Draw a frame around the text
          </label>
        </>
      )}
    </div>
  );
}

const ORIENTS = [
  { v: "n" as const, l: <ArrowUp />, title: "North (up)" },
  { v: "e" as const, l: <ArrowRight />, title: "East (right)" },
  { v: "s" as const, l: <ArrowDown />, title: "South (down)" },
  { v: "w" as const, l: <ArrowLeft />, title: "West (left)" },
];

function PinInspector({ pin, readOnly }: { pin: PinDef; readOnly: boolean }) {
  const d = readOnly;
  const doc = useEd((s) => s.doc);
  const dup = pin.number && doc.pins.filter((p) => p.number.trim() === pin.number.trim()).length > 1;
  const set = (k: keyof PinDef, v: unknown) =>
    useEd.getState().change((dd) => {
      const p = dd.pins.find((x) => x.id === pin.id);
      if (p) (p as Record<string, unknown>)[k] = v;
    }, `${pin.id}:${k}`);
  return (
    <div className="space-y-3 p-3">
      <Header title={`Pin ${pin.number || pin.name || ""}`} sub="Connection point for wires" readOnly={readOnly} />
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Number" value={pin.number} disabled={d} onChange={(v) => set("number", v)} />
        <TextField label="Name / function" value={pin.name} disabled={d} placeholder="e.g. A1, L1, +24V" onChange={(v) => set("name", v)} />
      </div>
      {dup && <p className="text-2xs text-danger">Another pin already uses number “{pin.number}”.</p>}
      <Seg label="Wire leaves towards" value={pin.orient} disabled={d} options={ORIENTS} onChange={(v) => set("orient", v)} />
      <div className="grid grid-cols-2 gap-2">
        <NumField label="X" value={pin.x} disabled={d} onChange={(v) => set("x", v)} />
        <NumField label="Y" value={pin.y} disabled={d} onChange={(v) => set("y", v)} />
      </div>
      <SelectField label="Type" value={pin.type || "Generic"} disabled={d} options={PIN_TYPES.map((t) => ({ v: t, l: t === "Generic" ? "Generic" : t === "Inner" ? "Inner (bridge side)" : "Outer (field side)" }))} onChange={(v) => set("type", v)} />
      <label className="flex items-center gap-2 text-xs">
        <Switch checked={!!pin.required} disabled={d} onCheckedChange={(v) => set("required", v)} aria-label="Must be connected" /> Must be connected (validation warns when left open)
      </label>
    </div>
  );
}
