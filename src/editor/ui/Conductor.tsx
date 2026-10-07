"use client";
/** Circuit (supply, potential, use) and conductor information (insulation color, cross-section, cable & core) of one or more wires. */
import { useMemo } from "react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { Section, Row, Commit } from "./Inspector";
import { NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getPage } from "@/core/ops";
import { computeNets } from "@/core/topology";
import type { Doc, Page, Wire, WirePot, WireUse } from "@/core/model";
import { COLORS, WIRE_POTS, WIRE_USES, assignCores, legacyCircuit, cableDesignation, circuitText, colorLabel, colorOf, makeCores, nextCableTag, sectionChoices, wireInfo, wirePot, wireUse, wiringOf } from "@/core/wiring";
import { circuitOf, sigSummary } from "@/core/circuit";
import { uid } from "@/core/ids";
import { GND_ID, gndLetterOf, wireNumberingOf } from "@/core/wirenumber";

const MIXED = "\u0000mixed";

export function Swatch({ code, className }: { code?: string; className?: string }) {
  const c = colorOf(code);
  if (!c) return <span className={"inline-block size-3 shrink-0 rounded-sm border border-dashed border-border " + (className ?? "")} />;
  const bg = c.hex2 ? `repeating-linear-gradient(135deg, ${c.hex} 0 3px, ${c.hex2} 3px 6px)` : c.hex;
  return <span className={"inline-block size-3 shrink-0 rounded-sm border border-black/15 " + (className ?? "")} style={{ background: bg }} title={c.name} />;
}

export function ConductorSection({ wires, page, doc, editable }: { wires: Wire[]; page: Page; doc: Doc; editable: boolean }) {
  const ui = useEditorUI();
  const ws = wiringOf(doc);
  const s = useEditor.getState;
  const pageId = useEditor((st) => st.pageId);
  const ids = useMemo(() => new Set(wires.map((w) => w.id)), [wires]);
  const upd = (label: string, fn: (w: Wire, d: Doc) => void) =>
    s().apply(label, (d) => {
      for (const w of getPage(d, page.id).wires) if (ids.has(w.id)) fn(w, d);
    });
  const same = <T,>(get: (w: Wire) => T): T | typeof MIXED => {
    const v = get(wires[0]);
    return wires.every((w) => get(w) === v) ? v : MIXED;
  };
  const insulation = same((w) => w.insulation ?? "");
  const section = same((w) => w.section ?? "");
  const cable = same((w) => w.cable ?? "");
  const single = wires.length === 1 ? wires[0] : null;
  const info = single ? wireInfo(doc, single) : null;
  const cables = doc.cables ?? [];
  const cableObj = cable !== MIXED ? cables.find((c) => c.tag === cable) : undefined;
  const usedCores = useMemo(() => {
    const m = new Map<string, number>();
    if (!cableObj) return m;
    for (const p of doc.pages) for (const w of p.wires) if (w.cable === cableObj.tag && w.core && !ids.has(w.id)) m.set(w.core, (m.get(w.core) ?? 0) + 1);
    return m;
  }, [doc.pages, cableObj, ids]);
  // the standard colour of this conductor's circuit (potential + use, set or detected)
  const circ = single ? circuitOf(doc, single.id) : undefined;
  const std = circ?.color;

  const setCable = (v: string) => {
    if (v === "__new") {
      const tag = nextCableTag(doc);
      const earth = wires.some((w) => wirePot(w) === "PE" || colorOf(w.insulation)?.code === "GNYE");
      const n = Math.max(2, wires.length);
      s().apply("New cable", (d) => {
        const c = { id: uid(), tag, cores: makeCores(n, n <= 5 ? "colors" : "numbered", earth), section: section !== MIXED && section ? section : undefined };
        d.cables = [...(d.cables ?? []), c];
        assignCores(d, c, getPage(d, page.id).wires.filter((w) => ids.has(w.id)));
      });
      ui.toast(`Cable ${tag} created — edit its type and cores in Wiring & cables`);
      return;
    }
    if (!v) return upd("Remove from cable", (w) => ((w.cable = undefined), (w.core = undefined)));
    s().apply("Assign to cable", (d) => {
      const c = (d.cables ?? []).find((x) => x.tag === v);
      const ws2 = getPage(d, page.id).wires.filter((w) => ids.has(w.id));
      if (c) assignCores(d, c, ws2);
      else for (const w of ws2) w.cable = v;
    });
  };
  const applyToNet = () => {
    if (!single) return;
    const net = computeNets(page).find((n) => n.wires.includes(single.id));
    if (!net) return;
    const others = new Set(net.wires);
    s().apply("Apply conductor data to net", (d) => {
      for (const w of getPage(d, page.id).wires) {
        if (!others.has(w.id) || w.id === single.id) continue;
        w.pot = wirePot(single);
        w.use = wireUse(single);
        w.fn = undefined;
        w.vclass = single.vclass;
        w.insulation = single.insulation;
        w.section = single.section;
      }
    });
    ui.toast(`Applied to ${net.wires.length - 1} other wire${net.wires.length === 2 ? "" : "s"} of the net`);
  };

  return (
    <>
    <CircuitSection wires={wires} doc={doc} editable={editable} upd={upd} />
    <Section title="Conductor" actions={<button className="text-2xs text-accent hover:underline" onClick={() => ui.openDialog("wiring")}>{ws.standard === "nfpa" ? "NFPA 79" : ws.standard === "jis" ? "JIS" : "IEC"} · settings</button>}>
      <datalist id="volt-wire-colors">
        {COLORS.map((c) => (
          <option key={c.code} value={ws.standard === "nfpa" ? c.us : c.code}>
            {c.name}
          </option>
        ))}
      </datalist>
      <datalist id="volt-wire-sections">
        {sectionChoices(ws.standard).map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <Row
        label="Color"
        hint={
          insulation === "" && single && info?.color
            ? `${info.colorSource === "core" ? `From cable core ${single.core}` : `Standard for ${circuitText(circ?.pot ?? undefined, circ?.use ?? undefined)}`}: ${colorLabel(info.color, ws.standard)} (${info.look?.name ?? info.color})`
            : insulation === "" && std
              ? `Standard for ${circuitText(circ?.pot ?? undefined, circ?.use ?? undefined)}: ${colorLabel(std, ws.standard)} — type it to put it on the wire`
              : undefined
        }
      >
        <div className="flex items-center gap-1.5">
          <Swatch code={insulation === MIXED ? undefined : insulation || info?.color || std} />
          <Commit
            value={insulation === MIXED ? "" : insulation}
            placeholder={insulation === MIXED ? "Mixed" : info?.color ? colorLabel(info.color, ws.standard) : "e.g. BK"}
            list="volt-wire-colors"
            disabled={!editable}
            onCommit={(v) => upd("Wire color", (w) => (w.insulation = normColor(v)))}
            aria-label="Insulation color"
          />
        </div>
      </Row>
      <Row label="Cross-section">
        <Commit
          value={section === MIXED ? "" : section}
          placeholder={section === MIXED ? "Mixed" : single && info?.section ? info.section : ws.standard === "nfpa" ? "e.g. 16 AWG" : ws.standard === "jis" ? "e.g. 1.25 sq" : "e.g. 1.5 mm²"}
          list="volt-wire-sections"
          disabled={!editable}
          onCommit={(v) => upd("Wire cross-section", (w) => (w.section = normSection(v, ws.standard)))}
          aria-label="Cross-section"
        />
      </Row>
      <Row label="Cable">
        <NativeSelect value={cable === MIXED ? MIXED : cable} disabled={!editable} onChange={(e) => setCable(e.target.value)} aria-label="Cable">
          {cable === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="">— single wire —</option>
          {cables.map((c) => (
            <option key={c.id} value={c.tag}>
              {c.tag} · {c.type || cableDesignation(c)}
            </option>
          ))}
          {cable && cable !== MIXED && !cableObj && <option value={cable}>{cable}</option>}
          <option value="__new">+ New cable{wires.length > 1 ? ` (${wires.length} cores)` : ""}</option>
        </NativeSelect>
      </Row>
      {single && cableObj && (
        <Row label="Core">
          <NativeSelect value={single.core ?? ""} disabled={!editable} onChange={(e) => upd("Cable core", (w) => (w.core = e.target.value || undefined))} aria-label="Core">
            <option value="">—</option>
            {cableObj.cores.map((k) => (
              <option key={k.name} value={k.name}>
                {k.name}
                {k.color && k.color !== k.name ? ` (${colorLabel(k.color, ws.standard)})` : ""}
                {usedCores.get(k.name) ? " · in use" : ""}
              </option>
            ))}
          </NativeSelect>
        </Row>
      )}
      {cableObj?.marks?.[pageId] && editable && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            s().apply("Reset cable mark", (d) => {
              const c = (d.cables ?? []).find((x) => x.tag === cableObj.tag);
              if (c?.marks) delete c.marks[pageId];
            })
          }
        >
          Reset cable mark and label position
        </Button>
      )}
      {!single && cableObj && editable && (
        <Button size="xs" variant="secondary" onClick={() => setCable(cableObj.tag)}>
          Re-assign cores in drawing order
        </Button>
      )}
      {single && editable && (
        <Button size="xs" variant="secondary" onClick={applyToNet}>
          Apply circuit, color and size to the whole net
        </Button>
      )}
    </Section>
    </>
  );
}

/**
 * Supply → wire-number letter; Potential → return suffix, connection checks; Use → with the
 * potential, the standard colour. Each "Automatic" shows what was detected and where from.
 */
function CircuitSection({ wires, doc, editable, upd }: { wires: Wire[]; doc: Doc; editable: boolean; upd: (label: string, fn: (w: Wire, d: Doc) => void) => void }) {
  const ui = useEditorUI();
  const cfg = wireNumberingOf(doc);
  const ws = wiringOf(doc);
  const single = wires.length === 1 ? wires[0] : null;
  const c = single ? circuitOf(doc, single.id) : undefined;
  const one = <T,>(get: (w: Wire) => T | undefined): T | "" | typeof MIXED => {
    const v = get(wires[0]) ?? "";
    return wires.every((w) => (get(w) ?? "") === v) ? (v as T | "") : MIXED;
  };
  const supply = one((w) => w.vclass);
  const pot = one((w) => wirePot(w));
  const use = one((w) => wireUse(w));
  const peOrSig = (pot === "PE" || pot === "signal") || (!pot && (c?.pot === "PE" || c?.pot === "signal"));
  const supplyName = c?.isGnd ? `${c.letter} · 0 V / GND${c.supply ? ` of ${c.supply.name}` : ""}` : c?.supply ? `${c.supply.letter} · ${c.supply.name}` : c?.letter === cfg.peLetter ? `${cfg.peLetter} · Protective earth` : c ? `${c.letter} · not determined` : "";
  const potName = c?.pot ? WIRE_POTS.find((x) => x.id === c.pot)?.short : "not determined";
  const useName = c?.use ? WIRE_USES.find((x) => x.id === c.use)?.name : "—";
  const sel = (v: string) => (v === MIXED ? MIXED : v);
  return (
    <Section
      title="Circuit"
      actions={
        <button className="text-2xs text-accent hover:underline" onClick={() => ui.openDialog("wireNumbers")}>
          Supplies · numbering
        </button>
      }
    >
      <Row label="Supply" hint={c && !c.supplySet ? `Detected from ${c.supplySource}.` : undefined}>
        <NativeSelect value={sel(supply)} disabled={!editable} onChange={(e) => e.target.value !== MIXED && upd("Wire supply", (w) => (w.vclass = e.target.value || undefined))} aria-label="Supply">
          {supply === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="">Automatic{c && !c.supplySet ? ` (${supplyName})` : ""}</option>
          {cfg.classes.map((x) => (
            <option key={x.id} value={x.id}>
              {x.letter} · {x.name}
            </option>
          ))}
          {gndLetterOf(cfg) && <option value={GND_ID}>{gndLetterOf(cfg)} · 0 V / GND (common)</option>}
          <option value="__pe">{cfg.peLetter} · Protective earth</option>
        </NativeSelect>
      </Row>
      <Row label="Potential" hint={c && !c.potSet && c.potSource ? `Detected from ${c.potSource}.` : undefined}>
        <NativeSelect
          value={sel(pot)}
          disabled={!editable}
          onChange={(e) => e.target.value !== MIXED && upd("Wire potential", (w) => (fromLegacy(w), (w.pot = (e.target.value || undefined) as WirePot | undefined)))}
          aria-label="Potential"
        >
          {pot === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="">Automatic{c && !c.potSet ? ` (${potName})` : ""}</option>
          {WIRE_POTS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </NativeSelect>
      </Row>
      {c?.sigs.length ? (
        <Row label="Bus lines">
          <span className="text-xs">{sigSummary(c.sigs)}</span>
        </Row>
      ) : null}
      <Row label="Use" hint={peOrSig ? "Not used for PE and signal conductors." : c && !c.useSet && c.useSource ? `From the ${c.useSource}.` : undefined}>
        <NativeSelect
          value={sel(use)}
          disabled={!editable || peOrSig}
          onChange={(e) => e.target.value !== MIXED && upd("Wire use", (w) => (fromLegacy(w), (w.use = (e.target.value || undefined) as WireUse | undefined)))}
          aria-label="Use"
        >
          {use === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="">Automatic{c && !c.useSet ? ` (${useName})` : ""}</option>
          {WIRE_USES.map((x) => (
            <option key={x.id} value={x.id} title={x.hint}>
              {x.name}
            </option>
          ))}
        </NativeSelect>
      </Row>
      {c && (
        <p className="text-2xs text-subtle">
          Number <b className="font-mono">{c.letter}…{c.suffix && cfg.returnSuffix ? cfg.returnSuffix : ""}</b>
          {c.color ? (
            <>
              {" "}· standard color <Swatch code={c.color} className="mx-0.5 align-[-2px]" />
              <b>{colorLabel(c.color, ws.standard)}</b>
            </>
          ) : null}
          {c.isReturn ? (c.isGnd ? " · 0 V / GND" : " · return") : ""}
        </p>
      )}
    </Section>
  );
}

/** an old "function" becomes potential + use before either is edited */
function fromLegacy(w: Wire) {
  if (!w.fn) return;
  const l = legacyCircuit(w.fn);
  w.pot ??= l.pot;
  w.use ??= l.use;
  w.fn = undefined;
}

/** "black" / "blk" / "gn/ye" → the standard code; anything unknown is kept as typed. */
export function normColor(v: string): string | undefined {
  const t = v.trim();
  if (!t) return undefined;
  return colorOf(t)?.code ?? t;
}

/** "1.5" → "1.5 mm²" (unit of the standard); "16" with NFPA → "16 AWG". Anything with a unit is kept. */
export function normSection(v: string, std: "iec" | "nfpa" | "jis"): string | undefined {
  const t = v.trim().replace(",", ".");
  if (!t) return undefined;
  if (/^\d+(\.\d+)?$/.test(t) || /^\d\/0$/.test(t)) return std === "nfpa" ? `${t} AWG` : std === "jis" ? `${t} sq` : `${t} mm²`;
  return t.replace(/\s*mm2$/i, " mm²").replace(/\s*sqmm$/i, " mm²");
}

