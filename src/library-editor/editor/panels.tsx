"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Crosshair, Grid3x3, ListOrdered, Plus, Trash2, X } from "lucide-react";
import { PIN_CLASSES, type ElementDef, type Orient } from "@/core/model";
import { inferPinClass, pinSigOf } from "@/core/pinclass";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { inputCls } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LINK_TYPES, validateDef, type Issue } from "@/lib/library/elmt-tools";
import { elementSvg } from "@/lib/library/preview";
import { useEd, defOf } from "./store";
import { TextField, SelectField } from "./fields";
import { centerOnOrigin, pinGridProblems, PIN_GRID, snapPinsToGrid } from "./actions";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/* Pin table                                                           */
/* ------------------------------------------------------------------ */

export function PinTable({ readOnly }: { readOnly: boolean }) {
  const pins = useEd((s) => s.doc.pins);
  const sel = useEd((s) => s.sel);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pins) if (p.number.trim()) m.set(p.number.trim(), (m.get(p.number.trim()) ?? 0) + 1);
    return m;
  }, [pins]);
  const set = (id: string, k: string, v: unknown) =>
    useEd.getState().change((d) => {
      const p = d.pins.find((x) => x.id === id);
      if (p) (p as Record<string, unknown>)[k] = v;
    }, `${id}:${k}`);
  const renumber = () =>
    useEd.getState().change((d) => {
      // top-to-bottom, then left-to-right
      const order = [...d.pins].sort((a, b) => a.x - b.x || a.y - b.y);
      order.forEach((p, i) => {
        const oldName = p.name;
        const wasSame = oldName === p.number;
        p.number = String(i + 1);
        if (wasSame || !oldName) p.name = p.number;
      });
    });
  const dups = [...counts.values()].some((c) => c > 1);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-2xs text-muted">
          {pins.length} pin{pins.length === 1 ? "" : "s"}
          {dups && <span className="ml-1 text-danger">· duplicate numbers</span>}
        </p>
        {!readOnly && pins.length > 0 && (
          <Button size="xs" variant="ghost" onClick={renumber} title="Number pins 1…N left-to-right, top-to-bottom">
            <ListOrdered /> Renumber
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {pins.length ? (
          <table className="w-full text-2xs">
            <thead className="sticky top-0 bg-panel-2 text-subtle">
              <tr className="[&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium">
                <th>No.</th>
                <th>Name</th>
                <th title="Wire leaves towards">Dir.</th>
                <th title="What the pin carries — Auto = from the name">Class</th>
                <th title="Must be connected">Req.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pins.map((p) => {
                const dup = !!p.number.trim() && (counts.get(p.number.trim()) ?? 0) > 1;
                const active = sel.includes(p.id);
                return (
                  <tr key={p.id} title={`Position ${p.x}, ${p.y} · ${p.type || "Generic"}`} className={cn("border-t border-border [&_td]:px-1.5 [&_td]:py-0.5", active && "bg-accent-soft")} onClick={() => useEd.getState().setSel([p.id])}>
                    <td>
                      <input value={p.number} disabled={readOnly} aria-label="Pin number" aria-invalid={dup} onChange={(e) => set(p.id, "number", e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={cn(inputCls, "h-6 w-14 px-1", dup && "border-danger text-danger")} />
                    </td>
                    <td>
                      <input value={p.name} disabled={readOnly} aria-label="Pin name" onChange={(e) => set(p.id, "name", e.target.value)} onKeyDown={(e) => e.stopPropagation()} className={cn(inputCls, "h-6 w-full min-w-14 px-1")} />
                    </td>
                    <td>
                      <select value={p.orient} disabled={readOnly} aria-label="Direction" onChange={(e) => set(p.id, "orient", e.target.value as Orient)} className={cn(inputCls, "h-6 w-11 px-1")}>
                        <option value="n">↑</option>
                        <option value="e">→</option>
                        <option value="s">↓</option>
                        <option value="w">←</option>
                      </select>
                    </td>
                    <td>
                      {(() => {
                        const auto = inferPinClass(p.name) ?? inferPinClass(p.number);
                        return (
                          <select
                            value={p.cls ?? ""}
                            disabled={readOnly}
                            aria-label="Pin class"
                            title={p.cls ? PIN_CLASSES.find((c) => c.id === p.cls)?.hint : `Auto: ${auto ?? "none"} (from the name)`}
                            onChange={(e) => set(p.id, "cls", e.target.value || undefined)}
                            className={cn(inputCls, "h-6 w-[4.5rem] px-1", !p.cls && "text-subtle")}
                          >
                            <option value="">{auto ? `Auto·${auto === "DC0" ? "0V" : auto === "signal" ? (() => { const g = pinSigOf(p); return g ? `${g.bus} ${g.line}` : "Sig"; })() : auto}` : "Auto"}</option>
                            {PIN_CLASSES.map((c) => (
                              <option key={c.id} value={c.id} title={c.label}>
                                {c.id === "DC0" ? "0V" : c.id === "signal" ? "Signal" : c.id === "none" ? "None" : c.id}
                              </option>
                            ))}
                          </select>
                        );
                      })()}
                    </td>
                    <td>
                      <Checkbox checked={!!p.required} disabled={readOnly} aria-label="Required" onCheckedChange={(v) => set(p.id, "required", v === true)} />
                    </td>
                    <td>
                      {!readOnly && (
                        <button
                          aria-label={`Delete pin ${p.number}`}
                          className="rounded p-0.5 text-subtle hover:text-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            useEd.getState().change((d) => {
                              d.pins = d.pins.filter((x) => x.id !== p.id);
                            });
                          }}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="p-4 text-2xs text-subtle">No pins yet. Choose the Pin tool (N) and click where a wire should connect.</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

const LANGS = ["en", "fr", "de", "es", "it", "nl", "pt", "pl", "cs", "ru", "zh", "ja", "ar", "hi", "ta"];

export function MetadataForm({ readOnly, categories }: { readOnly: boolean; categories: string[] }) {
  const names = useEd((s) => s.doc.names);
  const linkType = useEd((s) => s.doc.linkType);
  const kind = useEd((s) => s.doc.kind);
  const informations = useEd((s) => s.doc.informations);
  const meta = useEd((s) => s.meta);
  const setMeta = useEd((s) => s.setMeta);
  const [tagDraft, setTagDraft] = useState("");
  const d = readOnly;
  const change = useEd.getState().change;
  const setKind = (k: string, v: string) =>
    change((dd) => {
      if (v) dd.kind[k] = v;
      else delete dd.kind[k];
    }, `kind.${k}`);
  const addTag = () => {
    const t = tagDraft.trim().replace(/,$/, "");
    if (t && !meta.tags.includes(t)) setMeta({ tags: [...meta.tags, t] });
    setTagDraft("");
  };
  const missingLangs = LANGS.filter((l) => !(l in names));
  return (
    <div className="space-y-4 p-3">
      <TextField label="Name (English, required)" value={names.en ?? ""} disabled={d} placeholder="e.g. Relay coil 24 V DC" onChange={(v) => change((dd) => void (dd.names.en = v), "name.en")} />

      <section className="grid grid-cols-2 gap-2">
        <label className="col-span-2 flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">Category (folder path)</span>
          <input list="symed-cats" value={meta.category} disabled={d} placeholder="e.g. Relays/Coils" onChange={(e) => setMeta({ category: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className={inputCls} />
          <datalist id="symed-cats">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <TextField label="Reference prefix" value={meta.prefix} disabled={d} placeholder="K, Q, M, X…" onChange={(v) => setMeta({ prefix: v.slice(0, 16) })} />
        <SelectField label="Behaviour (link type)" value={linkType} disabled={d} options={LINK_TYPES.map((l) => ({ v: l.id, l: l.label }))} onChange={(v) => change((dd) => void (dd.linkType = v))} />
        {linkType === "master" && (
          <SelectField label="Master type" value={kind.type ?? "coil"} disabled={d} options={[{ v: "coil", l: "Coil" }, { v: "protection", l: "Protection" }, { v: "commutator", l: "Commutator" }]} onChange={(v) => setKind("type", v)} />
        )}
        {linkType === "slave" && (
          <>
            <SelectField
              label="Contact type"
              value={kind.type ?? "simple"}
              disabled={d}
              options={[
                { v: "simple", l: "Simple" },
                { v: "power", l: "Power" },
                { v: "delayOn", l: "Delay on" },
                { v: "delayOff", l: "Delay off" },
                { v: "delayOnOff", l: "Delay on/off" },
              ]}
              onChange={(v) => setKind("type", v)}
            />
            <SelectField label="State" value={kind.state ?? "NO"} disabled={d} options={[{ v: "NO", l: "Normally open (NO)" }, { v: "NC", l: "Normally closed (NC)" }, { v: "SW", l: "Changeover (SW)" }]} onChange={(v) => setKind("state", v)} />
          </>
        )}
        {linkType === "terminal" && (
          <SelectField
            label="Terminal function"
            value={kind.function ?? "generic"}
            disabled={d}
            options={[
              { v: "generic", l: "Generic" },
              { v: "phase", l: "Phase" },
              { v: "neutral", l: "Neutral" },
              { v: "pe", l: "Protective earth" },
            ]}
            onChange={(v) => setKind("function", v)}
          />
        )}
      </section>

      <section className="space-y-2">
        <TextField label="Description" multiline value={meta.description} disabled={d} placeholder="What is it, when to use it" onChange={(v) => setMeta({ description: v })} />
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Manufacturer" value={meta.manufacturer} disabled={d} onChange={(v) => setMeta({ manufacturer: v })} />
          <TextField label="Part number" value={meta.partNumber} disabled={d} onChange={(v) => setMeta({ partNumber: v })} />
        </div>
        <TextField label="Function" value={meta.function} disabled={d} placeholder="e.g. Motor protection" onChange={(v) => setMeta({ function: v })} />
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">Tags</span>
          <div className="flex flex-wrap gap-1">
            {meta.tags.map((t) => (
              <span key={t} className="inline-flex h-5 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-2xs">
                {t}
                {!d && (
                  <button aria-label={`Remove tag ${t}`} onClick={() => setMeta({ tags: meta.tags.filter((x) => x !== t) })} className="text-subtle hover:text-danger">
                    <X className="size-2.5" />
                  </button>
                )}
              </span>
            ))}
          </div>
          {!d && (
            <div className="flex gap-1">
              <input
                value={tagDraft}
                placeholder="Add tag and press Enter"
                aria-label="New tag"
                onChange={(e) => (e.target.value.endsWith(",") ? (setTagDraft(e.target.value), setTimeout(addTag)) : setTagDraft(e.target.value))}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") addTag();
                }}
                className={inputCls}
              />
              <Button size="icon" variant="ghost" onClick={addTag} aria-label="Add tag">
                <Plus />
              </Button>
            </div>
          )}
        </div>
      </section>

      <details className="group rounded-lg border border-border">
        <summary className="cursor-pointer select-none px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-muted">Translations ({Object.keys(names).filter((l) => l !== "en").length})</summary>
        <div className="space-y-1.5 px-3 pb-3">
        {Object.entries(names).filter(([lang]) => lang !== "en").map(([lang, v]) => (
          <div key={lang} className="flex items-center gap-1.5">
            <span className="w-8 shrink-0 text-2xs font-medium uppercase text-subtle">{lang}</span>
            <input
              value={v}
              disabled={d}
              aria-label={`Name (${lang})`}
              aria-required={lang === "en"}
              placeholder={lang === "en" ? "Required — e.g. Relay coil 24 V DC" : ""}
              onChange={(e) =>
                change((dd) => {
                  dd.names[lang] = e.target.value;
                }, `name.${lang}`)
              }
              onKeyDown={(e) => e.stopPropagation()}
              className={cn(inputCls, lang === "en" && !v.trim() && "border-danger")}
            />
            {lang !== "en" && !d && (
              <button
                aria-label={`Remove ${lang} name`}
                className="rounded p-1 text-subtle hover:text-danger"
                onClick={() =>
                  change((dd) => {
                    delete dd.names[lang];
                  })
                }
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        ))}
        {!d && missingLangs.length > 0 && (
          <select
            value=""
            aria-label="Add a translation"
            onChange={(e) =>
              e.target.value &&
              change((dd) => {
                dd.names[e.target.value] = "";
              })
            }
            className={cn(inputCls, "w-auto text-subtle")}
          >
            <option value="">+ Add translation…</option>
            {missingLangs.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
        </div>
      </details>
      <section className="space-y-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">Origin & license</h3>
        <TextField label="License" value={meta.license} disabled={d} placeholder="e.g. CC-BY 3.0, internal" onChange={(v) => setMeta({ license: v })} />
        <TextField label="Attribution / author" value={meta.attribution} disabled={d} onChange={(v) => setMeta({ attribution: v })} />
        <TextField label="Source (URL or document)" value={meta.source} disabled={d} onChange={(v) => setMeta({ source: v })} />
        <TextField label="Information text" multiline value={informations} disabled={d} placeholder="Author / license notes stored inside the .elmt file" onChange={(v) => change((dd) => void (dd.informations = v), "informations")} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function useIssues(): Issue[] {
  const doc = useEd((s) => s.doc);
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      const def = defOf(doc);
      const list = validateDef(def);
      const { off, crowded } = pinGridProblems(doc.pins);
      if (off.length) list.push({ level: "warning", message: `Pin(s) ${off.join(", ")} are off the ${PIN_GRID}-unit drawing grid — wires to them will jog sideways on diagrams.` });
      if (crowded.length) list.push({ level: "warning", message: `Pins ${crowded.map((c) => c.join(" & ")).join(", ")} are closer than ${PIN_GRID} units — they can't all line up with the drawing grid. Space pins ${PIN_GRID} or 20 units apart.` });
      setIssues(list);
    }, 150);
    return () => clearTimeout(t);
  }, [doc]);
  return issues;
}

export function ValidationList({ issues, readOnly }: { issues: Issue[]; readOnly: boolean }) {
  const pins = useEd((s) => s.doc.pins);
  const locate = (i: Issue) => {
    if (!i.target) return;
    if (i.target.startsWith("pin:")) useEd.getState().setSel([i.target.slice(4)]);
    else if (i.target.startsWith("pinnum:")) useEd.getState().setSel(pins.filter((p) => p.number.trim() === i.target!.slice(7)).map((p) => p.id));
  };
  const errors = issues.filter((i) => i.level === "error").length;
  return (
    <div className="space-y-2 p-3">
      {!issues.length ? (
        <p className="flex items-center gap-2 rounded-lg border border-success/20 bg-success-soft px-3 py-2 text-xs text-success">
          <CheckCircle2 className="size-4" /> {readOnly ? "No problems found." : "Looks good — ready to save."}
        </p>
      ) : (
        <p className="text-2xs text-muted">
          {errors ? `${errors} error${errors === 1 ? "" : "s"} must be fixed before saving.` : "Warnings do not block saving, but check them."}
        </p>
      )}
      <ul className="space-y-1">
        {issues.map((i, k) => (
          <li key={k}>
            <button onClick={() => locate(i)} disabled={!i.target} className={cn("flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-2xs", i.level === "error" ? "border-danger/20 bg-danger-soft text-danger" : "border-warning/25 bg-warning-soft text-warning", i.target && "hover:brightness-95")}>
              {i.level === "error" ? <AlertCircle className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
              <span>{i.message}</span>
            </button>
          </li>
        ))}
      </ul>
      {!readOnly && issues.some((i) => i.message.includes("drawing grid")) && (
        <Button size="sm" onClick={() => { const r = snapPinsToGrid(); (r.ok ? toast.success : toast.error)(r.message); }}>
          <Grid3x3 /> Snap pins to grid
        </Button>
      )}
      {!readOnly && issues.some((i) => i.message.includes("origin")) && (
        <Button size="sm" onClick={centerOnOrigin}>
          <Crosshair /> Center on origin
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live preview                                                        */
/* ------------------------------------------------------------------ */

export function LivePreview({ base }: { base: Partial<ElementDef> }) {
  const doc = useEd((s) => s.doc);
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const def = { ...defOf(doc), ...{ uuid: base.uuid ?? "" } } as ElementDef;
        const svg = elementSvg({ ...def, id: `pv${Date.now()}` }, { label: "K1", pinNumbers: true, pad: 4 });
        setUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      } catch {
        setUrl(null);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [doc, base.uuid]);
  if (!url) return null;
  if (!open)
    return (
      <button className="flex items-center gap-1.5 text-2xs text-muted hover:text-fg" onClick={() => setOpen(true)} aria-label="Show preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="h-5 rounded bg-white" /> Preview
      </button>
    );
  return (
    <div className="flex items-end gap-2" aria-label="Preview at diagram scale">
      <button onClick={() => setOpen(false)} className="absolute right-1 top-1 rounded p-0.5 text-subtle hover:bg-hover hover:text-fg" aria-label="Hide preview">
        <X className="size-3" />
      </button>
      {[
        { h: 24, l: "100%" },
        { h: 64, l: "Zoomed" },
      ].map((s) => (
        <figure key={s.l} className="flex flex-col items-center gap-0.5">
          <div className="flex items-center justify-center rounded-md border border-border bg-white p-1.5" style={{ height: s.h + 14, minWidth: s.h + 14 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" style={{ maxHeight: s.h, maxWidth: s.h * 2 }} />
          </div>
          <figcaption className="text-[10px] text-subtle">{s.l}</figcaption>
        </figure>
      ))}
      <figure className="flex flex-col items-center gap-0.5">
        <div className="flex items-center justify-center rounded-md border border-border bg-[#141417] p-1.5" style={{ height: 40 + 14, minWidth: 54 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="invert hue-rotate-180" style={{ maxHeight: 40, maxWidth: 80 }} />
        </div>
        <figcaption className="text-[10px] text-subtle">Dark</figcaption>
      </figure>
    </div>
  );
}
