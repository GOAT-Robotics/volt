"use client";
/** Conductor information of one or more wires: function, insulation color, cross-section, cable & core. */
import { useMemo } from "react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { Section, Row, Commit } from "./Inspector";
import { NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getPage } from "@/core/ops";
import { computeNets } from "@/core/topology";
import type { Doc, Page, Wire, WireFunction } from "@/core/model";
import { COLORS, FUNCTIONS, assignCores, cableDesignation, colorLabel, colorOf, makeCores, nextCableTag, sectionChoices, standardColor, wireInfo, wiringOf } from "@/core/wiring";
import { uid } from "@/core/ids";

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
  const ids = useMemo(() => new Set(wires.map((w) => w.id)), [wires]);
  const upd = (label: string, fn: (w: Wire, d: Doc) => void) =>
    s().apply(label, (d) => {
      for (const w of getPage(d, page.id).wires) if (ids.has(w.id)) fn(w, d);
    });
  const same = <T,>(get: (w: Wire) => T): T | typeof MIXED => {
    const v = get(wires[0]);
    return wires.every((w) => get(w) === v) ? v : MIXED;
  };
  const fn = same((w) => w.fn ?? "");
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
  const std = standardColor(fn === MIXED || !fn ? undefined : (fn as WireFunction), ws.standard);

  const setCable = (v: string) => {
    if (v === "__new") {
      const tag = nextCableTag(doc);
      const earth = wires.some((w) => w.fn === "PE" || colorOf(w.insulation)?.code === "GNYE");
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
        w.fn = single.fn;
        w.insulation = single.insulation;
        w.section = single.section;
      }
    });
    ui.toast(`Applied to ${net.wires.length - 1} other wire${net.wires.length === 2 ? "" : "s"} of the net`);
  };

  return (
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
      <Row label="Function">
        <NativeSelect value={fn === MIXED ? "" : fn} disabled={!editable} onChange={(e) => upd("Wire function", (w) => (w.fn = (e.target.value || undefined) as WireFunction | undefined))} aria-label="Wire function">
          <option value="">{fn === MIXED ? "Mixed" : "—"}</option>
          {FUNCTIONS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <Row
        label="Color"
        hint={
          insulation === "" && single && info?.color
            ? `${info.colorSource === "core" ? `From cable core ${single.core}` : `Standard for this function`}: ${colorLabel(info.color, ws.standard)} (${info.look?.name ?? info.color})`
            : insulation === "" && std
              ? `Standard: ${colorLabel(std, ws.standard)}`
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
      {!single && cableObj && editable && (
        <Button size="xs" variant="secondary" onClick={() => setCable(cableObj.tag)}>
          Re-assign cores in drawing order
        </Button>
      )}
      {single && editable && (
        <Button size="xs" variant="secondary" onClick={applyToNet}>
          Apply function, color and size to the whole net
        </Button>
      )}
    </Section>
  );
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
