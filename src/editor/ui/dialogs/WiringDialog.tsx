"use client";
import { useMemo, useState } from "react";
import { Plus, Trash2, Download } from "lucide-react";
import { useEditor } from "../../store";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Switch, Checkbox } from "@/components/ui/misc";
import type { Cable, Doc, WiringSettings, WiringStandard } from "@/core/model";
import { STANDARDS, FUNCTIONS, cableDesignation, colorLabel, colorOf, makeCores, sectionChoices, standardColor, wireInfo, wiringOf, type CoreScheme } from "@/core/wiring";
import { uid } from "@/core/ids";
import { cn } from "@/lib/utils";
import { Swatch, normSection } from "../Conductor";

const PRESETS: { label: string; n: number; scheme: CoreScheme; earth: boolean }[] = [
  { label: "2 × (BN BU)", n: 2, scheme: "colors", earth: false },
  { label: "3G (BN BU GNYE)", n: 3, scheme: "colors", earth: true },
  { label: "4G (BN BK GY GNYE)", n: 4, scheme: "colors", earth: true },
  { label: "5G (BN BK GY BU GNYE)", n: 5, scheme: "colors", earth: true },
  { label: "3 × numbered + GNYE", n: 4, scheme: "numbered", earth: true },
  { label: "7 × numbered + GNYE", n: 7, scheme: "numbered", earth: true },
  { label: "12 × numbered + GNYE", n: 12, scheme: "numbered", earth: true },
  { label: "4 × DIN 47100 (data)", n: 4, scheme: "din47100", earth: false },
  { label: "8 × DIN 47100 (data)", n: 8, scheme: "din47100", earth: false },
];

export function WiringDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const editable = useEditor((s) => !s.version || s.version.editable);
  const [ws, setWs] = useState<WiringSettings>(() => wiringOf(doc));
  const [cables, setCables] = useState<(Cable & { origTag?: string })[]>(() => (doc.cables ?? []).map((c) => ({ ...c, origTag: c.tag })));
  const [preset, setPreset] = useState(2);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of doc.pages) for (const w of p.wires) if (w.cable) m.set(w.cable, (m.get(w.cable) ?? 0) + 1);
    return m;
  }, [doc.pages]);
  // cable tags used on wires but not defined yet
  const undefinedTags = [...usage.keys()].filter((t) => !cables.some((c) => c.origTag === t || c.tag === t));

  const upd = (i: number, p: Partial<Cable>) => setCables(cables.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const nextTag = () => {
    const used = new Set([...cables.map((c) => c.tag), ...usage.keys()]);
    for (let i = 1; ; i++) if (!used.has(`W${i}`)) return `W${i}`;
  };
  const add = (tag?: string) => {
    const p = PRESETS[preset];
    setCables([...cables, { id: uid(), tag: tag ?? nextTag(), cores: makeCores(p.n, p.scheme, p.earth), section: sectionChoices(ws.standard)[ws.standard === "nfpa" ? 5 : 6], origTag: tag }]);
  };
  const dupTags = new Set(cables.map((c) => c.tag).filter((t, i, a) => t && a.indexOf(t) !== i));

  const save = () => {
    useEditor.getState().apply("Wiring & cables", (d) => {
      d.wiring = { ...ws };
      const renamed = new Map<string, string>();
      const kept = new Set<string>();
      for (const c of cables) {
        if (c.origTag && c.origTag !== c.tag) renamed.set(c.origTag, c.tag);
        kept.add(c.origTag ?? c.tag);
      }
      const removed = new Set((d.cables ?? []).map((c) => c.tag).filter((t) => !kept.has(t)));
      for (const p of d.pages)
        for (const w of p.wires) {
          if (!w.cable) continue;
          if (renamed.has(w.cable)) w.cable = renamed.get(w.cable);
          else if (removed.has(w.cable)) (w.cable = undefined), (w.core = undefined);
        }
      d.cables = cables.map(({ origTag: _o, ...c }) => ({ ...c, tag: c.tag.trim(), type: c.type?.trim() || undefined, section: c.section?.trim() || undefined, length: c.length?.trim() || undefined }));
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide title="Wiring & cables" description="Colour and cross-section conventions, how conductor information is shown, and the cables of this project.">
        <div className="max-h-[68vh] space-y-5 overflow-auto pr-1">
          <section>
            <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">Standard</h3>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(STANDARDS) as WiringStandard[]).map((k) => (
                <button
                  key={k}
                  disabled={!editable}
                  onClick={() => setWs({ ...ws, standard: k })}
                  className={cn("rounded-lg border p-2.5 text-left transition-colors", ws.standard === k ? "border-accent bg-accent-soft" : "border-border hover:bg-hover")}
                >
                  <p className="text-xs font-medium">{STANDARDS[k].name}</p>
                  <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
                    {(["power", "acControl", "dcControl", "N", "PE", "interlock"] as const).map((f) => {
                      const c = standardColor(f, k)!;
                      return (
                        <span key={f} className="flex items-center gap-1 text-2xs text-muted">
                          <Swatch code={c} /> {FUNCTIONS.find((x) => x.id === f)!.name.replace(/ \(.*\)/, "").replace("Protective earth ", "")}
                        </span>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-2xs text-subtle">Sizes in {STANDARDS[k].unit === "awg" ? "AWG" : STANDARDS[k].unit === "sq" ? "sq (mm²)" : "mm²"}</p>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-2xs text-subtle">A wire's colour comes from, in order: its own colour, its cable core, then the standard colour for its function. Changing the standard updates standard colours only.</p>
          </section>

          <section>
            <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">On the drawing</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {(
                [
                  ["showColor", "Show colour code (or cable core)"],
                  ["showSection", "Show cross-section"],
                  ["tick", "Tick mark at the annotation"],
                  ["colorize", "Draw wires in their insulation colour"],
                  ["weightBySection", "Heavier lines for larger cross-sections"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="flex h-7 items-center justify-between text-xs">
                  {l}
                  <Switch checked={ws[k]} disabled={!editable} onCheckedChange={(v) => setWs({ ...ws, [k]: v })} />
                </label>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">Cables</h3>
              {editable && (
                <div className="flex items-center gap-1">
                  <NativeSelect value={preset} onChange={(e) => setPreset(Number(e.target.value))} className="h-7 w-52" aria-label="Cable preset">
                    {PRESETS.map((p, i) => (
                      <option key={i} value={i}>
                        {p.label}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button size="xs" onClick={() => add()}>
                    <Plus /> Add cable
                  </Button>
                </div>
              )}
            </div>
            <datalist id="volt-cable-sections">
              {sectionChoices(ws.standard).map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
            {!cables.length && !undefinedTags.length ? (
              <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-subtle">
                No cables yet. Add one here, or select the wires of a cable on the drawing and choose <b>Cable → New cable</b> in the Conductor panel.
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-2xs text-subtle">
                    <th className="pb-1 font-medium">Tag</th>
                    <th className="pb-1 font-medium">Type / part</th>
                    <th className="pb-1 font-medium">Cores</th>
                    <th className="pb-1 font-medium">Section</th>
                    <th className="pb-1 pr-2 font-medium">Shield</th>
                    <th className="pb-1 font-medium">Length</th>
                    <th className="pb-1 text-right font-medium">Used</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cables.map((c, i) => {
                    const used = usage.get(c.origTag ?? c.tag) ?? 0;
                    return (
                      <tr key={c.id} className="border-t border-border align-top">
                        <td className="py-1 pr-1">
                          <Input value={c.tag} disabled={!editable} onChange={(e) => upd(i, { tag: e.target.value })} className={cn("h-7 w-16", dupTags.has(c.tag) && "border-danger")} aria-label="Cable tag" />
                        </td>
                        <td className="py-1 pr-1">
                          <Input value={c.type ?? ""} disabled={!editable} placeholder={cableDesignation(c)} onChange={(e) => upd(i, { type: e.target.value })} className="h-7" aria-label="Cable type" />
                        </td>
                        <td className="py-1 pr-1">
                          <CoresInput cable={c} disabled={!editable} onChange={(cores) => upd(i, { cores })} std={ws.standard} />
                        </td>
                        <td className="py-1 pr-1">
                          <Input value={c.section ?? ""} disabled={!editable} list="volt-cable-sections" onChange={(e) => upd(i, { section: e.target.value })} onBlur={(e) => upd(i, { section: normSection(e.target.value, ws.standard) })} className="h-7 w-24" aria-label="Cable cross-section" />
                        </td>
                        <td className="py-1 pr-1 pt-2.5">
                          <Checkbox checked={!!c.shield} disabled={!editable} onCheckedChange={(v) => upd(i, { shield: !!v })} aria-label="Shielded" />
                        </td>
                        <td className="py-1 pr-1">
                          <Input value={c.length ?? ""} disabled={!editable} placeholder="m" onChange={(e) => upd(i, { length: e.target.value })} className="h-7 w-16" aria-label="Length" />
                        </td>
                        <td className={cn("py-1 pt-2 text-right tabular", used > c.cores.length && "font-medium text-danger")} title={used > c.cores.length ? "More wires than cores" : undefined}>
                          {used}/{c.cores.length}
                        </td>
                        <td className="py-1 pl-1">
                          <Button variant="ghost" size="icon-sm" disabled={!editable} onClick={() => setCables(cables.filter((_, j) => j !== i))} aria-label={`Delete cable ${c.tag}`}>
                            <Trash2 />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {undefinedTags.length > 0 && (
              <p className="mt-2 text-2xs text-muted">
                Cable tags on wires without a cable definition:{" "}
                {undefinedTags.map((t) => (
                  <button key={t} disabled={!editable} className="mr-1 rounded border border-border px-1 hover:bg-hover" onClick={() => add(t)}>
                    + {t}
                  </button>
                ))}
              </p>
            )}
          </section>
        </div>
        <DialogFooter className="justify-between">
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => downloadCsv(`${doc.meta.title || "project"} - wire list.csv`, wireListRows({ ...doc, wiring: ws, cables }))}>
              <Download /> Wire list
            </Button>
            <Button size="sm" variant="ghost" onClick={() => downloadCsv(`${doc.meta.title || "project"} - cable list.csv`, cableListRows({ ...doc, wiring: ws, cables }))}>
              <Download /> Cable list
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!editable || dupTags.size > 0 || cables.some((c) => !c.tag.trim())} onClick={save}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CoresInput({ cable, onChange, disabled, std }: { cable: Cable; onChange: (c: Cable["cores"]) => void; disabled: boolean; std: WiringStandard }) {
  const text = cable.cores.map((k) => k.name).join(", ");
  const [v, setV] = useState(text);
  const commit = () => {
    const names = v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    onChange(names.map((n) => ({ name: n, color: colorOf(n)?.code ?? cable.cores.find((k) => k.name === n)?.color ?? "BK" })));
  };
  return (
    <div>
      <Input value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={commit} className="h-7" aria-label="Cores" title="Core names, comma separated (colour codes or numbers)" />
      <div className="mt-1 flex flex-wrap gap-0.5">
        {cable.cores.map((k, i) => (
          <span key={i} className="inline-flex items-center gap-0.5 rounded bg-panel-2 px-1 text-2xs text-muted">
            <Swatch code={k.color} className="!size-2.5" />
            {colorOf(k.name) ? colorLabel(k.name, std) : k.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lists                                                                */
/* ------------------------------------------------------------------ */

function endText(doc: Doc, pageIdx: number, end: import("@/core/model").WireEnd): string {
  if (end.k !== "pin") return end.k === "junction" ? "(junction)" : "(open)";
  const page = doc.pages[pageIdx];
  const e = page.elements.find((x) => x.id === end.el);
  const def = e && doc.defs[e.defId];
  const pin = def?.pins.find((p) => p.id === end.pin);
  return `${e?.info.label || def?.name || "?"}:${pin?.number || pin?.name || "?"}`;
}

function wireListRows(doc: Doc): string[][] {
  const ws = wiringOf(doc);
  const rows = [["Page", "Wire", "From", "To", "Function", "Colour", "Cross-section", "Cable", "Core"]];
  const pages = [...doc.pages].sort((a, b) => a.order - b.order);
  pages.forEach((p) => {
    const idx = doc.pages.indexOf(p);
    for (const w of p.wires) {
      const i = wireInfo(doc, w);
      rows.push([p.title, w.label ?? "", endText(doc, idx, w.a), endText(doc, idx, w.b), FUNCTIONS.find((f) => f.id === w.fn)?.name ?? "", i.color ? colorLabel(i.color, ws.standard) : "", i.section ?? "", w.cable ?? "", w.core ?? ""]);
    }
  });
  return rows;
}

function cableListRows(doc: Doc): string[][] {
  const ws = wiringOf(doc);
  const rows = [["Cable", "Type", "Cores", "Core list", "Cross-section", "Shield", "Length", "Wires assigned", "Pages"]];
  for (const c of doc.cables ?? []) {
    const wires = doc.pages.flatMap((p) => p.wires.filter((w) => w.cable === c.tag).map((w) => ({ w, p })));
    rows.push([
      c.tag,
      c.type ?? cableDesignation(c),
      String(c.cores.length),
      c.cores.map((k) => (colorOf(k.name) ? colorLabel(k.name, ws.standard) : k.name)).join(" "),
      c.section ?? "",
      c.shield ? "yes" : "",
      c.length ?? "",
      String(wires.length),
      [...new Set(wires.map((x) => x.p.title))].join(", "),
    ]);
  }
  return rows;
}

function downloadCsv(name: string, rows: string[][]) {
  const csv = "﻿" + rows.map((r) => r.map((v) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
