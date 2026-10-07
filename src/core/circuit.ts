/**
 * The circuit of every conductor, as the wire panel shows it:
 *
 *   Supply     which voltage system it belongs to (B · 24 V DC) → the wire-number letter
 *   Potential  what it carries in that system (L1 … N, + / 0 V / −, PE, signal) → return suffix, checks
 *   Use        power / control / external supply → with the potential, the standard insulation colour
 *
 * Each is taken from the wire when set there, else detected: the supply by wire numbering's
 * classification (rails, supply ratings, pins, through two-terminal devices), the potential from
 * rails and pin classes on the conductor, the use from the supply's default. Signal conductors also
 * list the bus lines they connect (CAN H, UART TX → RX …).
 */
import type { Doc, Wire, WireClass, WirePot, WireUse } from "./model";
import { indexElements, projectNets, type ProjectNet } from "./erc";
import { pinClassOf, pinSigOf } from "./pinclass";
import { sigText, type SigRef } from "./signals";
import { classifyNets, supplyUse, wireNumberingOf } from "./wirenumber";
import { standardColorFor, wirePot, wireUse, wiringOf } from "./wiring";

export type Circuit = {
  supply: WireClass | null;
  /** wire-number letter (supply letter, PE letter, or the fallback) */
  letter: string;
  supplySource: string;
  supplySet: boolean;
  pot: WirePot | null;
  potSource: string;
  potSet: boolean;
  use: WireUse | null;
  useSource: string;
  useSet: boolean;
  /** 0 V / N: the number gets the return suffix */
  isReturn: boolean;
  /** standard insulation colour for this standard (IEC 60757 code) */
  color?: string;
  /** bus lines of the signal pins on this conductor */
  sigs: SigRef[];
};

const POT_OF_LABEL: Record<string, WirePot> = { L1: "L1", L2: "L2", L3: "L3", L: "L", N: "N", PE: "PE", PEN: "PE", "DC+": "DC+", "DC-": "DC-", DC0: "DC0" };
const cache = new WeakMap<Doc, Map<string, Circuit>>();

export function circuits(doc: Doc): Map<string, Circuit> {
  const hit = cache.get(doc);
  if (hit) return hit;
  const cfg = wireNumberingOf(doc);
  const std = wiringOf(doc).standard;
  const idx = indexElements(doc);
  const pn = projectNets(doc, idx);
  const cls = classifyNets(doc, cfg, { idx, ...pn });
  const wires = new Map<string, Wire>();
  for (const p of doc.pages) for (const w of p.wires) wires.set(w.id, w);
  const byId = new Map(cfg.classes.map((c) => [c.id, c]));
  const out = new Map<string, Circuit>();
  for (const n of pn.nets) {
    const c = cls.get(n.id);
    const supply = c?.classId && c.classId !== "__pe" ? byId.get(c.classId) ?? null : null;
    const net = detectPot(n, idx, wires, c?.isPe ?? false, c?.isReturn ?? false, supply);
    const netUse = n.wires.map((x) => wires.get(x.id)).map((w) => w && wireUse(w)).find(Boolean) as WireUse | undefined;
    const sigs: SigRef[] = [];
    for (const r of n.pins) {
      const pd = idx.get(r.el)?.def?.pins.find((q) => q.id === r.pin);
      const s = pd && pinSigOf(pd);
      if (s && !sigs.some((x) => x.bus === s.bus && x.line === s.line)) sigs.push(s);
    }
    for (const { id } of n.wires) {
      const w = wires.get(id);
      if (!w) continue;
      const pSet = wirePot(w), uSet = wireUse(w);
      const pot = pSet ?? net.pot;
      const use = pot === "PE" || pot === "signal" ? null : uSet ?? netUse ?? supplyUse(supply ?? undefined) ?? null;
      out.set(id, {
        supply,
        letter: c?.letter ?? cfg.fallbackLetter,
        supplySource: c?.source ?? "not determined",
        supplySet: !!w.vclass,
        pot,
        potSource: pSet ? "set on the wire" : net.source,
        potSet: !!pSet,
        use,
        useSource: uSet ? "set on the wire" : netUse ? "set on a wire of this conductor" : supply && use ? `default of ${supply.name}` : "",
        useSet: !!uSet,
        isReturn: pot === "DC0" || pot === "N" || (c?.isReturn ?? false),
        color: standardColorFor(pot ?? undefined, use ?? undefined, std, supply?.kind),
        sigs,
      });
    }
  }
  cache.set(doc, out);
  return out;
}

export const circuitOf = (doc: Doc, wireId: string): Circuit | undefined => circuits(doc).get(wireId);

function detectPot(n: ProjectNet, idx: ReturnType<typeof indexElements>, wires: Map<string, Wire>, isPe: boolean, isReturn: boolean, supply: WireClass | null): { pot: WirePot | null; source: string } {
  if (isPe) return { pot: "PE", source: "protective earth circuit" };
  for (const { id } of n.wires) {
    const w = wires.get(id);
    const p = w && wirePot(w);
    if (p) return { pot: p, source: "set on a wire of this conductor" };
  }
  const lab = n.potentials.find((p) => p.from === "label");
  if (lab && POT_OF_LABEL[lab.kind]) return { pot: POT_OF_LABEL[lab.kind], source: `rail ${lab.text}` };
  const pins = new Map<WirePot, string>();
  for (const r of n.pins) {
    const x = idx.get(r.el);
    const pd = x?.def?.pins.find((q) => q.id === r.pin);
    const c = pd && pinClassOf(pd);
    if (c && c !== "none" && !pins.has(c)) pins.set(c, `pin ${x!.e.info.label || x!.def!.name}:${pd!.name || pd!.number}`);
  }
  const power = [...pins.keys()].filter((k) => k !== "signal");
  if (power.length === 1) return { pot: power[0], source: pins.get(power[0])! };
  if (!power.length && pins.has("signal")) return { pot: "signal", source: pins.get("signal")! };
  if (supply?.kind === "signal") return { pot: "signal", source: supply.name };
  if (supply?.kind === "dc") return { pot: isReturn ? "DC0" : "DC+", source: `${supply.name}${isReturn ? " return" : ""}` };
  if (supply?.kind === "ac") return isReturn ? { pot: "N", source: `${supply.name} neutral` } : { pot: null, source: "" };
  return { pot: null, source: "" };
}

/** "CAN H · CAN H", "UART TX → RX" */
export function sigSummary(sigs: SigRef[]): string {
  if (!sigs.length) return "";
  const lines = sigs.map(sigText);
  return sigs.length === 2 && sigs[0].bus === sigs[1].bus && sigs[0].line !== sigs[1].line ? `${lines[0]} → ${sigs[1].line}` : lines.join(" · ");
}
