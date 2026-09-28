"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Box, CircleDot, Copy, FileImage, FilePlus2, Lightbulb, Loader2, ToggleLeft, Search, Cpu, Sparkles } from "lucide-react";
import { AiElementPanel } from "./AiElementPanel";
import { toast } from "sonner";
import type { ElementDef } from "@/core/model";
import { serializeElmt } from "@/core/qet/elmt";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { elementSvg } from "@/lib/library/preview";
import { blankDef, finalizeDef } from "@/lib/library/elmt-tools";
import { blankTemplate, boxTemplate, coilTemplate, contactTemplate, labelText, lampTemplate, motorTemplate, type BoxOpts, type ContactOpts, type MotorOpts } from "../templates";
import { svgToPrims } from "../svg-import";
import type { LibItem } from "../types";
import { PreviewImg } from "../shared/common";

type Start = "ai" | "blank" | "box" | "coil" | "contact" | "motor" | "lamp" | "duplicate" | "svg";

const STARTS: { id: Start; title: string; desc: string; icon: React.ReactNode }[] = [
  { id: "ai", title: "Describe or sketch (AI)", desc: "Type what you need, draw it or upload a picture", icon: <Sparkles /> },
  { id: "blank", title: "Blank", desc: "Start from an empty canvas", icon: <FilePlus2 /> },
  { id: "box", title: "Box with pins", desc: "Connector, terminal strip, PLC card…", icon: <Cpu /> },
  { id: "coil", title: "Relay coil", desc: "A1 / A2, links to its contacts", icon: <Box /> },
  { id: "contact", title: "Contact NO / NC", desc: "Relay contact or switch", icon: <ToggleLeft /> },
  { id: "motor", title: "Motor", desc: "Circle with M, 1 or 3 phase", icon: <CircleDot /> },
  { id: "lamp", title: "Indicator lamp", desc: "Circle with a cross", icon: <Lightbulb /> },
  { id: "duplicate", title: "Copy an existing element", desc: "Start from any element you can see", icon: <Copy /> },
  { id: "svg", title: "Import SVG drawing", desc: "Trace a vendor symbol, then add pins", icon: <FileImage /> },
];

const DEFAULT_NAMES: Record<Start, string> = { ai: "", blank: "", box: "Connector", coil: "Relay coil", contact: "Contact NO", motor: "Motor 3-phase", lamp: "Indicator lamp", duplicate: "", svg: "" };
const DEFAULT_CAT: Record<Start, string> = { ai: "Custom", blank: "Custom", box: "Connectors", coil: "Relays & contactors/Coils", contact: "Relays & contactors/Contacts", motor: "Motors & drives", lamp: "Signalling & HMI", duplicate: "", svg: "Custom" };

export function NewElementWizard({ open, onClose, categories, defaultCategory }: { open: boolean; onClose: () => void; categories: string[]; defaultCategory?: string }) {
  const router = useRouter();
  const [start, setStart] = useState<Start | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState<BoxOpts>({ left: 4, right: 4, pitch: 10, width: 40, leftLabels: "", rightLabels: "", showNames: true, kind: "connector" });
  const [contact, setContact] = useState<ContactOpts>({ state: "NO", role: "slave", numbers: "" });
  const [motor, setMotor] = useState<MotorOpts>({ phases: 3, pe: true });
  const [svg, setSvg] = useState<{ file: string; prims: ElementDef["prims"]; warnings: string[] } | null>(null);
  const [svgSize, setSvgSize] = useState(60);
  const svgText = useRef<string>("");
  const [dup, setDup] = useState<LibItem | null>(null);
  const [aiDef, setAiDef] = useState<ElementDef | null>(null);

  useEffect(() => {
    if (!open) {
      setStart(null);
      setSvg(null);
      setDup(null);
      setAiDef(null);
    }
  }, [open]);

  const choose = (s: Start) => {
    setStart(s);
    setName(DEFAULT_NAMES[s]);
    setCategory(defaultCategory || DEFAULT_CAT[s]);
    setPrefix({ ai: "", box: "X", coil: "K", contact: "", motor: "M", lamp: "H", blank: "", duplicate: "", svg: "" }[s]);
  };

  const def = useMemo<ElementDef | null>(() => {
    const n = name.trim() || "New element";
    try {
      switch (start) {
        case "ai":
          return aiDef ? { ...aiDef, name: n, names: { ...aiDef.names, en: n } } : null;
        case "blank":
          return blankTemplate(n);
        case "box":
          return boxTemplate(n, box);
        case "coil":
          return coilTemplate(n);
        case "contact":
          return contactTemplate(n, contact);
        case "motor":
          return motorTemplate(n, motor);
        case "lamp":
          return lampTemplate(n);
        case "svg":
          if (!svg) return null;
          return finalizeDef(blankDef(n, { prims: [...svg.prims, labelText(Math.round(svgSize / 2 + 6), -Math.round(svgSize / 2))], info: { label: "" } }));
        default:
          return null;
      }
    } catch {
      return null;
    }
  }, [start, name, box, contact, motor, svg, svgSize, aiDef]);

  const preview = useMemo(() => {
    if (!def) return null;
    try {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(elementSvg(def, { label: prefix ? `${prefix}1` : "K1", pinNumbers: !(start === "box" && box.showNames), pad: 4 }))}`;
    } catch {
      return null;
    }
  }, [def, prefix, start, box.showNames]);

  const loadSvg = async (f: File, size = svgSize) => {
    try {
      const text = await f.text();
      svgText.current = text;
      const r = svgToPrims(text, size);
      setSvg({ file: f.name, prims: r.prims, warnings: r.warnings });
      if (!name) setName(f.name.replace(/\.svg$/i, "").replace(/[_-]+/g, " "));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  useEffect(() => {
    if (!svgText.current || start !== "svg") return;
    try {
      const r = svgToPrims(svgText.current, svgSize);
      setSvg((s) => (s ? { ...s, prims: r.prims } : s));
    } catch {}
  }, [svgSize, start]);

  const create = async () => {
    setBusy(true);
    try {
      let id: string;
      if (start === "duplicate") {
        if (!dup) return;
        const j = await api<{ id: string }>(`/api/library/elements/${dup.id}/duplicate`, { method: "POST", json: { name: name.trim() || undefined } });
        id = j.id;
        if (category.trim() || prefix.trim()) await api(`/api/library/elements/${id}`, { method: "PATCH", json: { ...(category.trim() ? { category } : {}), ...(prefix.trim() ? { prefix } : {}) } });
      } else {
        if (!def) return;
        const content = serializeElmt({ ...def, prefix, category });
        const j = await api<{ id: string }>("/api/library/elements", {
          method: "POST",
          json: { name: name.trim(), category, prefix, visibility: "PRIVATE", content, description: "", note: start === "svg" ? `Created from SVG ${svg?.file ?? ""}` : start === "ai" ? "Drawn with AI from a description / sketch" : `Created from template: ${start}` },
        });
        id = j.id;
      }
      toast.success("Element created — add or adjust pins, then save");
      onClose();
      router.push(`/library/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={start ? STARTS.find((s) => s.id === start)!.title : "New element"} description={start ? undefined : "Pick a starting point. You can change everything afterwards in the editor."} wide="xl">
        {!start ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STARTS.map((s) => (
              <button key={s.id} onClick={() => choose(s.id)} className="group flex flex-col items-start gap-1.5 rounded-lg border border-border p-3 text-left hover:border-accent/50 hover:bg-accent-soft">
                <span className="rounded-md border border-border bg-panel-2 p-1.5 text-muted group-hover:text-accent [&_svg]:size-4">{s.icon}</span>
                <span className="text-xs font-medium">{s.title}</span>
                <span className="text-2xs text-muted">{s.desc}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[1fr_280px]">
            <div className="space-y-3">
              <button className="flex items-center gap-1 text-2xs text-muted hover:text-fg" onClick={() => setStart(null)}>
                <ArrowLeft className="size-3" /> Other starting points
              </button>
              {start === "duplicate" && <DuplicatePicker value={dup} onPick={(it) => (setDup(it), setName(`${it.name} (copy)`), setCategory(it.category), setPrefix(it.prefix))} />}
              {start === "box" && (
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
                  <Field label="Kind">
                    <NativeSelect value={box.kind} onChange={(e) => setBox({ ...box, kind: e.target.value as BoxOpts["kind"] })}>
                      <option value="connector">Connector</option>
                      <option value="terminal">Terminal strip</option>
                      <option value="plc">PLC / IO card / module</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Pin spacing" hint="10 = one diagram grid square">
                    <NativeSelect value={box.pitch} onChange={(e) => setBox({ ...box, pitch: Number(e.target.value) })}>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={30}>30</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Pins on the left">
                    <Input type="number" min={0} max={64} value={box.left} onChange={(e) => setBox({ ...box, left: Math.max(0, Math.min(64, Number(e.target.value) || 0)) })} />
                  </Field>
                  <Field label="Pins on the right">
                    <Input type="number" min={0} max={64} value={box.right} onChange={(e) => setBox({ ...box, right: Math.max(0, Math.min(64, Number(e.target.value) || 0)) })} />
                  </Field>
                  <Field label="Left pin labels" hint="Comma list, or a range like 1-8 / I0-I7">
                    <Input value={box.leftLabels} placeholder="1, 2, 3, 4" onChange={(e) => setBox({ ...box, leftLabels: e.target.value })} />
                  </Field>
                  <Field label="Right pin labels">
                    <Input value={box.rightLabels} placeholder={`${box.left + 1}, ${box.left + 2}, …`} onChange={(e) => setBox({ ...box, rightLabels: e.target.value })} />
                  </Field>
                  <Field label="Box width">
                    <NativeSelect value={box.width} onChange={(e) => setBox({ ...box, width: Number(e.target.value) })}>
                      {[20, 40, 60, 80, 100].map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-1 text-xs">
                    <Switch checked={box.showNames} onCheckedChange={(v) => setBox({ ...box, showNames: v })} /> Show labels inside the box
                  </label>
                </div>
              )}
              {start === "contact" && (
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
                  <Field label="State at rest">
                    <NativeSelect value={contact.state} onChange={(e) => (setContact({ ...contact, state: e.target.value as "NO" | "NC" }), setName(`Contact ${e.target.value}`))}>
                      <option value="NO">Normally open (NO)</option>
                      <option value="NC">Normally closed (NC)</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Used as">
                    <NativeSelect value={contact.role} onChange={(e) => (setContact({ ...contact, role: e.target.value as "slave" | "switch" }), setPrefix(e.target.value === "switch" ? "S" : ""))}>
                      <option value="slave">Contact of a relay (linked to its coil)</option>
                      <option value="switch">Standalone switch</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Pin numbers" hint={contact.state === "NO" ? "Default 13, 14" : "Default 11, 12"}>
                    <Input value={contact.numbers} placeholder={contact.state === "NO" ? "13, 14" : "11, 12"} onChange={(e) => setContact({ ...contact, numbers: e.target.value })} />
                  </Field>
                </div>
              )}
              {start === "motor" && (
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
                  <Field label="Supply">
                    <NativeSelect value={motor.phases} onChange={(e) => setMotor({ ...motor, phases: Number(e.target.value) as 1 | 3 })}>
                      <option value={3}>3-phase (U1 V1 W1)</option>
                      <option value={1}>1-phase (L N)</option>
                    </NativeSelect>
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-1 text-xs">
                    <Switch checked={motor.pe} onCheckedChange={(v) => setMotor({ ...motor, pe: v })} /> Protective earth pin
                  </label>
                </div>
              )}
              {start === "ai" && (
                <AiElementPanel
                  onResult={(r) => {
                    setAiDef(r?.def ?? null);
                    if (r) {
                      setName(r.symbol.name || name);
                      if (r.symbol.category) setCategory(r.symbol.category);
                      setPrefix(r.def.prefix);
                    }
                  }}
                />
              )}
              {start === "svg" && (
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong px-4 py-6 text-center hover:bg-hover">
                    <FileImage className="size-5 text-subtle" />
                    <span className="text-xs font-medium">{svg ? svg.file : "Choose an SVG file"}</span>
                    <span className="text-2xs text-muted">Lines, shapes and paths are converted; curves become polylines. Text is skipped.</span>
                    <input type="file" accept=".svg,image/svg+xml" className="sr-only" onChange={(e) => e.target.files?.[0] && loadSvg(e.target.files[0])} />
                  </label>
                  {svg && (
                    <>
                      <p className="text-2xs text-muted">{svg.prims.length} shapes imported. After creating, add pins with the Pin tool.</p>
                      {svg.warnings.map((w, i) => (
                        <p key={i} className="text-2xs text-warning">
                          {w}
                        </p>
                      ))}
                      <Field label={`Size: ${svgSize} units (≈ ${svgSize / 10} grid squares)`}>
                        <input type="range" min={20} max={200} step={10} value={svgSize} onChange={(e) => setSvgSize(Number(e.target.value))} aria-label="Symbol size" />
                      </Field>
                    </>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name" className="col-span-2">
                  <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Terminal block 8-way" />
                </Field>
                <Field label="Category (folder)">
                  <Input list="wiz-cats" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Connectors" />
                  <datalist id="wiz-cats">
                    {categories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Reference prefix" hint="Letter used for tags: K1, Q2, X3…">
                  <Input value={prefix} onChange={(e) => setPrefix(e.target.value.slice(0, 16))} placeholder="e.g. K" />
                </Field>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-2xs font-medium text-muted">Preview</p>
              <div className="flex min-h-56 flex-1 items-center justify-center rounded-lg border border-border bg-white p-4">
                {start === "duplicate" ? (
                  dup ? (
                    <PreviewImg id={dup.id} rev={dup.revision} className="max-h-52 max-w-full dark:invert-0 dark:hue-rotate-0" pins label="K1" />
                  ) : (
                    <span className="text-2xs text-subtle">Pick an element</span>
                  )
                ) : preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="Preview" className="max-h-52 max-w-full" />
                ) : (
                  <span className="text-2xs text-subtle">{start === "svg" ? "Choose a file" : start === "ai" ? "Generate to see the element" : "—"}</span>
                )}
              </div>
              {def && start !== "duplicate" && (
                <p className="text-2xs text-subtle">
                  {def.pins.length} pins · {def.width}×{def.height} units · saved as a private draft
                </p>
              )}
            </div>
          </div>
        )}
        {start && (
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !name.trim() || (start === "duplicate" ? !dup : !def)} onClick={create}>
              {busy && <Loader2 className="animate-spin" />} Create and open editor
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DuplicatePicker({ value, onPick }: { value: LibItem | null; onPick: (it: LibItem) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LibItem[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ items: LibItem[] }>(`/api/library/elements?${new URLSearchParams({ q, scope: "all", kind: "ELEMENT", limit: "60" })}`)
        .then((j) => setItems(j.items))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
        <Input className="pl-7" placeholder="Search elements…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search elements to copy" />
      </div>
      <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-auto sm:grid-cols-4">
        {items.map((it) => (
          <button key={it.id} onClick={() => onPick(it)} className={cn("flex flex-col items-center gap-1 rounded-md border p-1.5 text-center hover:bg-hover", value?.id === it.id ? "border-accent bg-accent-soft" : "border-border")}>
            <span className="flex h-12 w-full items-center justify-center rounded bg-white">
              <PreviewImg id={it.id} rev={it.revision} className="max-h-10 max-w-full dark:invert-0 dark:hue-rotate-0" />
            </span>
            <span className="line-clamp-2 text-[10px] leading-tight">{it.name}</span>
          </button>
        ))}
        {!items.length && <p className="col-span-full p-3 text-2xs text-subtle">No elements found.</p>}
      </div>
    </div>
  );
}
