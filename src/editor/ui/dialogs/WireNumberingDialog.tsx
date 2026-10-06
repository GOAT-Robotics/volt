"use client";
/** Automatic wire numbering: scheme, voltage classes, preview and apply. */
import { useMemo, useState } from "react";
import { Plus, Trash2, Info } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Badge, Switch, TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/misc";
import type { WireClass, WireNumbering } from "@/core/model";
import { applyWireNumbers, DEFAULT_CLASSES, formatWireLabel, planWireNumbers, PRESETS, wireNumberingOf } from "@/core/wirenumber";
import { uid } from "@/core/ids";
import { cn } from "@/lib/utils";

const WHY: Record<string, string> = { new: "new", renumber: "renumbered", class: "class changed", segment: "segment", merge: "circuits joined", kept: "" };

export function WireNumberingDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const [cfg, setCfg] = useState<WireNumbering>(() => structuredClone(wireNumberingOf(doc)));
  const [mode, setMode] = useState<"new" | "all">(doc.wireNumbering ? "new" : "all");
  const [scope, setScope] = useState<"all" | "page">("all");
  const [tab, setTab] = useState(doc.wireNumbering ? "preview" : "scheme");
  const up = (p: Partial<WireNumbering>) => setCfg((c) => ({ ...c, ...p, preset: p.preset ?? (p.format || p.segments !== undefined ? "custom" : c.preset) }));
  const upClass = (i: number, p: Partial<WireClass>) => setCfg((c) => ({ ...c, classes: c.classes.map((x, k) => (k === i ? { ...x, ...p } : x)) }));
  const plan = useMemo(() => planWireNumbers(doc, { mode, pageIds: scope === "page" ? [pageId] : undefined }, cfg), [doc, mode, scope, pageId, cfg]);
  const pageTitle = useMemo(() => new Map(doc.pages.map((p) => [p.id, p.title])), [doc.pages]);
  const example = (cls: string, ret = false, seg = "A") => formatWireLabel(cfg, { cls, n: 12, seg, ret, page: 3, col: 7, row: "C", size: "1.5" });
  const badRegex = cfg.classes.find((c) => {
    if (!c.match) return false;
    try {
      new RegExp(c.match);
      return false;
    } catch {
      return true;
    }
  });

  const save = () =>
    useEditor.getState().apply("Wire numbering settings", (d) => {
      d.wireNumbering = cfg;
    });
  const apply = () => {
    const p = plan;
    useEditor.getState().apply(`Number ${p.changes.length} wire${p.changes.length === 1 ? "" : "s"}`, (d) => {
      d.wireNumbering = cfg;
      applyWireNumbers(d, p);
    });
    ui.toast(`${p.changes.length} wire number${p.changes.length === 1 ? "" : "s"} assigned`, { undo: true });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Automatic wire numbering"
        description="Groups conductors into circuits, detects each circuit's voltage system and gives every wire an identifier for the drawing, ferrules and harness labels. Locked numbers are never changed."
        wide="xl"
      >
        <TabsRoot value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="scheme">Scheme</TabsTrigger>
            <TabsTrigger value="classes">Voltage classes</TabsTrigger>
            <TabsTrigger value="preview">
              Preview {plan.changes.length > 0 && <Badge tone="accent" className="ml-1">{plan.changes.length}</Badge>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="scheme" className="space-y-3 pt-3 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              {(["harness", "panel"] as const).map((k) => (
                <button
                  key={k}
                  disabled={!editable}
                  onClick={() => setCfg((c) => ({ ...c, ...PRESETS[k] }))}
                  className={cn("rounded-lg border p-3 text-left hover:bg-hover", cfg.preset === k ? "border-accent bg-accent-soft" : "border-border")}
                >
                  <p className="font-semibold">{k === "harness" ? "Harness / per wire (recommended)" : "Panel / per sheet & column"}</p>
                  <p className="mt-0.5 font-mono text-2xs">{k === "harness" ? "B012A  B012B  B013AN  PE001A" : "B3.7  B3.12  A5.4"}</p>
                  <p className="mt-1 text-2xs text-muted">
                    {k === "harness"
                      ? "Class letter + circuit number + segment letter, N for returns — the SAE AS50881 structure used for vehicle, robot and aircraft harnesses. Every physical wire has a unique ID; numbers stay stable when the drawing changes."
                      : "Class letter + sheet + column where the circuit starts (EPLAN / IEC 61082 style). Easy to find on the drawing, but numbers change when circuits move. One number per conductor."}
                  </p>
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-2xs text-muted">Format</span>
                <Input value={cfg.format} disabled={!editable} className="font-mono" onChange={(e) => up({ format: e.target.value })} />
                <span className="block text-2xs text-subtle">{"{class} {n} {n:3} {seg} {ret} {page} {col} {row} {size}"}</span>
              </label>
              <div className="space-y-1">
                <span className="text-2xs text-muted">Examples</span>
                <p className="font-mono">
                  {example("B")} · {example("B", false, "B")} · {example("B", true)} · {example(cfg.peLetter)}
                </p>
              </div>
              <label className="flex items-center gap-2">
                <Switch checked={cfg.segments} disabled={!editable} onCheckedChange={(v) => up({ segments: v })} /> Segment letter for every wire of a circuit
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={cfg.replacePotentialNames} disabled={!editable} onCheckedChange={(v) => up({ replacePotentialNames: v })} /> Replace rail names (L1, N, +24V, 0V) with numbers
              </label>
              <label className="flex items-center gap-2">
                Return suffix
                <Input value={cfg.returnSuffix} disabled={!editable} className="w-16 font-mono" onChange={(e) => up({ returnSuffix: e.target.value.toUpperCase().slice(0, 3) })} />
              </label>
              <label className="flex items-center gap-2">
                Start at
                <Input type="number" value={cfg.start} disabled={!editable} className="w-20" onChange={(e) => up({ start: Math.max(0, Number(e.target.value) || 1) })} />
              </label>
              <label className="flex items-center gap-2">
                Protective earth
                <Input value={cfg.peLetter} disabled={!editable} className="w-16 font-mono" onChange={(e) => up({ peLetter: e.target.value.toUpperCase().slice(0, 3) })} />
              </label>
              <label className="flex items-center gap-2">
                Unclassified
                <Input value={cfg.fallbackLetter} disabled={!editable} className="w-16 font-mono" onChange={(e) => up({ fallbackLetter: e.target.value.toUpperCase().slice(0, 3) })} />
              </label>
            </div>
            <p className="flex items-start gap-1.5 rounded-md border border-border bg-panel-2 p-2 text-2xs text-muted">
              <Info className="mt-0.5 size-3 shrink-0" />
              IEC 60204-1 (13.2.1) and IEC 62491 require that each conductor is identifiable at each end in agreement with the documentation; the letters themselves are your choice. Keep segment letters for harnesses (a printed sleeve per wire); for cabinet wiring one number per conductor is common. Letters I, O and N are not used as segment letters.
            </p>
          </TabsContent>

          <TabsContent value="classes" className="pt-3 text-xs">
            <table className="w-full">
              <thead className="text-2xs text-subtle">
                <tr>
                  <th className="py-1 text-left font-medium">Letter</th>
                  <th className="text-left font-medium">Name</th>
                  <th className="text-left font-medium">Kind</th>
                  <th className="text-left font-medium">Volts</th>
                  <th className="text-left font-medium">Also matches names (regex)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cfg.classes.map((c, i) => (
                  <tr key={c.id}>
                    <td className="w-16 py-0.5 pr-1">
                      <Input value={c.letter} disabled={!editable} className="font-mono" onChange={(e) => upClass(i, { letter: e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) })} />
                    </td>
                    <td className="pr-1">
                      <Input value={c.name} disabled={!editable} onChange={(e) => upClass(i, { name: e.target.value })} />
                    </td>
                    <td className="w-28 pr-1">
                      <NativeSelect value={c.kind} disabled={!editable} onChange={(e) => upClass(i, { kind: e.target.value as WireClass["kind"] })}>
                        <option value="dc">DC</option>
                        <option value="ac">AC</option>
                        <option value="signal">Signal</option>
                        <option value="any">Any</option>
                      </NativeSelect>
                    </td>
                    <td className="w-20 pr-1">
                      <Input type="number" value={c.volts ?? ""} disabled={!editable || c.kind === "signal"} onChange={(e) => upClass(i, { volts: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    </td>
                    <td className="pr-1">
                      <Input value={c.match ?? ""} disabled={!editable} className={cn("font-mono", badRegex === c && "border-danger")} placeholder="e.g. CAN|RS485" onChange={(e) => upClass(i, { match: e.target.value || undefined })} />
                    </td>
                    <td>
                      <Button variant="ghost" size="icon-sm" disabled={!editable} onClick={() => setCfg((x) => ({ ...x, classes: x.classes.filter((_, k) => k !== i) }))} aria-label="Remove class">
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button size="xs" variant="secondary" disabled={!editable} onClick={() => setCfg((x) => ({ ...x, classes: [...x.classes, { id: uid(), letter: "", name: "", kind: "dc" }] }))}>
                <Plus /> Add class
              </Button>
              <Button size="xs" variant="ghost" disabled={!editable} onClick={() => setCfg((x) => ({ ...x, classes: structuredClone(DEFAULT_CLASSES) }))}>
                Reset to defaults
              </Button>
              <label className="flex items-center gap-1.5">
                DC of unknown voltage →
                <NativeSelect value={cfg.defaultDc ?? ""} disabled={!editable} className="w-36" onChange={(e) => up({ defaultDc: e.target.value || undefined })}>
                  <option value="">Unclassified</option>
                  {cfg.classes.filter((c) => c.kind === "dc").map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.letter} · {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex items-center gap-1.5">
                AC →
                <NativeSelect value={cfg.defaultAc ?? ""} disabled={!editable} className="w-36" onChange={(e) => up({ defaultAc: e.target.value || undefined })}>
                  <option value="">Unclassified</option>
                  {cfg.classes.filter((c) => c.kind === "ac").map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.letter} · {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </div>
            <p className="mt-3 text-2xs text-subtle">
              A circuit's class comes from, in this order: the class set on a wire (Conductor panel), rail names (+24V, 0V, L1, N, PE, 230VAC), the conductor function, existing numbers, pin names of the
              connected devices (supply outputs “+24V”, a “+” output of a supply rated 24 V …), and is then carried through fuses, switches, contacts, coils and other two-terminal devices — not through power supplies, converters or modules.
            </p>
          </TabsContent>

          <TabsContent value="preview" className="pt-3 text-xs">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as "new" | "all")} className="w-72">
                <option value="new">Number new wires (keep existing numbers)</option>
                <option value="all">Renumber everything in order (closes gaps)</option>
              </NativeSelect>
              <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as "all" | "page")} className="w-44">
                <option value="all">Entire project</option>
                <option value="page">Current sheet only</option>
              </NativeSelect>
              <span className="text-2xs text-subtle">
                {plan.stats.circuits} circuits · {plan.stats.wires} wires · {plan.stats.locked} locked
                {plan.stats.unclassified > 0 && <span className="text-warning"> · {plan.stats.unclassified} unclassified ({cfg.fallbackLetter})</span>}
              </span>
            </div>
            {mode === "all" && doc.wireNumbering && <p className="mb-2 text-2xs text-warning">Renumbering changes identifiers that may already be printed on sleeves and harness labels.</p>}
            <div className="grid gap-3 lg:grid-cols-[1fr_1.3fr]">
              <div className="max-h-80 overflow-auto rounded-md border border-border">
                <table className="w-full">
                  <thead className="sticky top-0 bg-panel-2 text-2xs text-subtle">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Circuit</th>
                      <th className="text-left font-medium">Class</th>
                      <th className="text-left font-medium">Wires</th>
                      <th className="text-left font-medium">Detected from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.circuits.slice(0, 800).map((c) => (
                      <tr key={c.key} className="border-t border-border">
                        <td className="px-2 py-1 font-mono">{c.label}</td>
                        <td className={cn(c.letter === cfg.fallbackLetter && "text-warning")}>{c.className}</td>
                        <td className="tabular">{c.wires}</td>
                        <td className="text-2xs text-muted">
                          {c.source}
                          {c.conflict && <span className="block text-warning">{c.conflict}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="max-h-80 overflow-auto rounded-md border border-border">
                <table className="w-full">
                  <thead className="sticky top-0 bg-panel-2 text-2xs text-subtle">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Sheet</th>
                      <th className="text-left font-medium">From</th>
                      <th className="text-left font-medium">To</th>
                      <th className="text-left font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.changes.slice(0, 1500).map((c) => (
                      <tr key={c.wireId} className="border-t border-border">
                        <td className="max-w-32 truncate px-2 py-1">{pageTitle.get(c.pageId)}</td>
                        <td className="font-mono text-danger line-through">{c.from || "∅"}</td>
                        <td className="font-mono text-success">{c.to}</td>
                        <td className="text-2xs text-muted">{WHY[c.why]}</td>
                      </tr>
                    ))}
                    {!plan.changes.length && (
                      <tr>
                        <td colSpan={4} className="p-6 text-center text-subtle">
                          Every wire already has its number.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </TabsContent>
        </TabsRoot>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={!editable || !!badRegex} onClick={() => (save(), onClose())}>
            Save settings
          </Button>
          <Button variant="primary" disabled={!editable || !plan.changes.length || !!badRegex} onClick={apply}>
            Apply {plan.changes.length} number{plan.changes.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
