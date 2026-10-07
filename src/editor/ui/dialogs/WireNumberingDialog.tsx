"use client";
/** Automatic wire numbering: scheme, supplies, preview and apply. */
import { useMemo, useState } from "react";
import { Plus, Trash2, Info } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Badge, Switch, TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/misc";
import type { WireClass, WireNumbering } from "@/core/model";
import { applyWireNumbers, DEFAULT_CLASSES, formatWireLabel, planWireNumbers, PRESETS, RESERVED_CLASS_LETTERS, supplyUse, wireNumberingOf } from "@/core/wirenumber";
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
  /** a class letter that is reserved (X = terminals), empty, or used twice */
  const letterProblem = (c: WireClass): string | null =>
    !c.letter
      ? "Give the class a letter"
      : RESERVED_CLASS_LETTERS.includes(c.letter)
        ? `"${c.letter}" is the terminal-strip letter (X1:3) — wire numbers would read like terminals`
        : c.letter === cfg.peLetter || c.letter === cfg.fallbackLetter || (cfg.gndMode === "letter" && c.letter === (cfg.gndLetter || "G")) || cfg.classes.some((o) => o !== c && o.letter === c.letter)
          ? `"${c.letter}" is already used`
          : null;
  const badLetter = cfg.classes.find((c) => letterProblem(c));
  /** 0 V / GND is the return of a supply, never a supply of its own */
  const groundSupply = cfg.classes.find((c) => /\b(gnd|ground|0\s?v|earth|return)\b/i.test(c.name) || c.volts === 0);
  const fixedLetter = (v: string) => v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  const gndLetter = cfg.gndLetter || "G";
  const gndClash = cfg.gndMode === "letter" && (gndLetter === cfg.peLetter || gndLetter === cfg.fallbackLetter || cfg.classes.some((c) => c.letter === gndLetter));
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
        description="Groups conductors into circuits, detects each circuit's supply and gives every wire an identifier for the drawing, ferrules and harness labels. Locked numbers are never changed."
        wide="xl"
      >
        <TabsRoot value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="scheme">Scheme</TabsTrigger>
            <TabsTrigger value="classes">Supplies</TabsTrigger>
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
                  <th className="text-left font-medium" title="Colour of its conductors when a wire doesn't say: power → black, control → red (AC) / blue (DC)">Default use</th>
                  <th className="text-left font-medium">Also matches names (regex)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cfg.classes.map((c, i) => (
                  <tr key={c.id}>
                    <td className="w-16 py-0.5 pr-1">
                      <Input value={c.letter} disabled={!editable} title={letterProblem(c) ?? undefined} aria-invalid={!!letterProblem(c)} className={cn("font-mono", letterProblem(c) && "border-danger")} onChange={(e) => upClass(i, { letter: e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) })} />
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
                    <td className="w-28 pr-1">
                      <NativeSelect value={supplyUse(c) ?? ""} disabled={!editable || c.kind === "signal"} onChange={(e) => upClass(i, { use: (e.target.value || undefined) as WireClass["use"] })} aria-label="Default use">
                        <option value="">—</option>
                        <option value="power">Power</option>
                        <option value="control">Control</option>
                      </NativeSelect>
                    </td>
                    <td className="pr-1">
                      <Input value={c.match ?? ""} disabled={!editable} className={cn("font-mono", badRegex === c && "border-danger")} placeholder="e.g. CAN|RS485" onChange={(e) => upClass(i, { match: e.target.value || undefined })} />
                    </td>
                    <td>
                      <Button variant="ghost" size="icon-sm" disabled={!editable} onClick={() => setCfg((x) => ({ ...x, classes: x.classes.filter((_, k) => k !== i) }))} aria-label="Remove supply">
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
                {/* fixed rows: they are not supplies, but they get letters too */}
                <tr className="border-t border-dashed border-border">
                  <td className="w-16 py-0.5 pr-1">
                    {cfg.gndMode === "letter" ? (
                      <Input value={gndLetter} disabled={!editable} aria-invalid={gndClash} className={cn("font-mono", gndClash && "border-danger")} onChange={(e) => up({ gndLetter: fixedLetter(e.target.value) || undefined })} />
                    ) : (
                      <span className="px-2 font-mono text-subtle" title="The letter of the supply it returns">B…{cfg.returnSuffix}</span>
                    )}
                  </td>
                  <td className="pr-1" colSpan={2}>
                    <NativeSelect value={cfg.gndMode ?? "return"} disabled={!editable} onChange={(e) => up({ gndMode: e.target.value as "return" | "letter" })} aria-label="0 V / GND numbering">
                      <option value="return">0 V / GND — return of its supply ({example("B", true)})</option>
                      <option value="letter">0 V / GND — own letter for all 0 V ({example(gndLetter)})</option>
                    </NativeSelect>
                  </td>
                  <td className="pr-1 text-subtle">0</td>
                  <td className="pr-1 text-subtle">as its supply</td>
                  <td className="text-2xs text-subtle" colSpan={2}>
                    {cfg.gndMode === "letter" ? "Use when every 0 V in the panel is bonded together (PELV)." : "Keeps each supply's 0 V apart (isolated supplies, harnesses)."}
                  </td>
                </tr>
                <tr>
                  <td className="w-16 py-0.5 pr-1">
                    <Input value={cfg.peLetter} disabled={!editable} className="font-mono" onChange={(e) => up({ peLetter: fixedLetter(e.target.value) })} aria-label="Protective earth letter" />
                  </td>
                  <td className="pr-1 text-xs" colSpan={2}>
                    Protective earth (PE)
                  </td>
                  <td className="pr-1 text-subtle">—</td>
                  <td className="pr-1 text-subtle">—</td>
                  <td className="text-2xs text-subtle" colSpan={2}>Never a return, never mixed with 0 V.</td>
                </tr>
                <tr>
                  <td className="w-16 py-0.5 pr-1">
                    <Input value={cfg.fallbackLetter} disabled={!editable} className="font-mono" onChange={(e) => up({ fallbackLetter: fixedLetter(e.target.value) })} aria-label="Unclassified letter" />
                  </td>
                  <td className="pr-1 text-xs" colSpan={2}>
                    Unclassified
                  </td>
                  <td className="pr-1 text-subtle">—</td>
                  <td className="pr-1 text-subtle">—</td>
                  <td className="text-2xs text-subtle" colSpan={2}>Circuits whose supply could not be found — set a Supply on one of their wires.</td>
                </tr>
              </tbody>
            </table>
            {badLetter && <p className="mt-1 text-2xs text-danger">{letterProblem(badLetter)}</p>}
            {gndClash && <p className="mt-1 text-2xs text-danger">The 0 V / GND letter “{gndLetter}” is already used by a supply, PE or Unclassified.</p>}
            {groundSupply && (
              <p className="mt-1 text-2xs text-warning">
                “{groundSupply.letter} · {groundSupply.name}” looks like 0 V / ground. That is not a supply: remove it and use the fixed “0 V / GND” row below the supplies — either the return of its supply (B…{cfg.returnSuffix}) or its own letter. Set those wires' Potential to “0 V / GND”.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button size="xs" variant="secondary" disabled={!editable} onClick={() => setCfg((x) => ({ ...x, classes: [...x.classes, { id: uid(), letter: "", name: "", kind: "dc" }] }))}>
                <Plus /> Add supply
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
              A supply is a voltage system: its letter starts every wire number of its circuits (B012A), its default use gives the standard colour. A conductor's supply comes from, in this order: the supply set on the wire (Circuit panel), rail names (+24V, 0V, L1, N, PE, 230VAC), the potential set on the wire, existing numbers, pins of the
              connected devices (pin classes, supply outputs “+24V”, a “+” output of a supply rated 24 V …), and is then carried through fuses, switches, contacts, coils and other two-terminal devices — not through power supplies, converters or modules.
              N is the return of its AC supply (suffix {cfg.returnSuffix || "none"}); 0 V / GND is numbered as set in its row. A negative supply (−15 V) is an ordinary supply with negative volts. Default use: power → black, control → red (AC) / blue (DC).
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
          <Button variant="secondary" disabled={!editable || !!badRegex || !!badLetter || gndClash} onClick={() => (save(), onClose())}>
            Save settings
          </Button>
          <Button variant="primary" disabled={!editable || !plan.changes.length || !!badRegex || !!badLetter || gndClash} onClick={apply}>
            Apply {plan.changes.length} number{plan.changes.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
