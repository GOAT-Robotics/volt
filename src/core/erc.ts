/**
 * Electrical rule check (ERC) over the whole project: connections, naming, short circuits, wrong
 * wiring, safety and conductor cross-sections. Deterministic — the AI reviewer runs it first, posts
 * its findings and hands the result (plus the project netlist) to the language model for the
 * engineering review that rules cannot do.
 *
 * Nets are project wide: wires, junctions, mated connectors, folio reports (QET "next/previous
 * report" pairs), two-pin feed-through terminals and junction elements join them.
 */
import type { Doc, ElemInst, ElementDef, Page, Wire, WireFunction } from "./model";
import { prefixFor } from "./numbering";
import { matedPinPairs, isConnector } from "./mating";
import { colorOf, sectionMm2, wireInfo, wiringOf } from "./wiring";
import { circuitKey, wireNumberingOf } from "./wirenumber";

export type ErcLevel = "error" | "warning" | "info";
export type ErcCategory = "connection" | "naming" | "short" | "wiring" | "safety" | "section";
export type ErcFinding = {
  level: ErcLevel;
  code: string;
  category: ErcCategory;
  message: string;
  suggestion: string;
  pageId?: string;
  /** element / wire ids the finding is about (first one is the anchor) */
  ids: string[];
  anchor?: { type: "element" | "wire"; id: string; x: number; y: number };
};

/* ------------------------------------------------------------------ */
/* Potentials                                                           */
/* ------------------------------------------------------------------ */

export type PotKind = "L1" | "L2" | "L3" | "L" | "N" | "PE" | "PEN" | "DC+" | "DC-" | "DC0";
export type Potential = { kind: PotKind; volts?: number; text: string };

/** potential named by a wire label / rail name ("L1", "N", "PE", "+24V", "0V", "230VAC", "GND") */
export function potentialOfLabel(raw: string | undefined | null): Potential | null {
  if (!raw) return null;
  const p = potentialOfName(raw);
  if (p) return p;
  // QElectroTech-style potential numbering: L1.4, N.3, +24V.2, 0V-1
  const m = /^(.+?)[.\-_](\d+)$/.exec(raw.trim());
  return m && !/^\d+$/.test(m[1]) ? potentialOfName(m[1], raw.trim()) : null;
}

function potentialOfName(raw: string, shown?: string): Potential | null {
  const p = potentialOfName0(raw);
  return p && shown ? { ...p, text: shown } : p;
}

function potentialOfName0(raw: string): Potential | null {
  const text = raw.trim();
  const t = text.toUpperCase().replace(/\s+/g, "").replace(/^[-=]?(?=[A-Z])/, "");
  if (!t) return null;
  if (t === "L1") return { kind: "L1", text };
  if (t === "L2") return { kind: "L2", text };
  if (t === "L3") return { kind: "L3", text };
  if (/^(L|L\+?AC|LINE|PH(ASE)?)$/.test(t)) return { kind: "L", text };
  if (/^(N|MP|NEUTRAL)$/.test(t)) return { kind: "N", text };
  if (/^(PE|GNYE|EARTH|PROTECTIVEEARTH)$/.test(t)) return { kind: "PE", text };
  if (/^PEN$/.test(t)) return { kind: "PEN", text };
  if (/^(0V(DC)?|GND|M\d+V?|DC0V?)$/.test(t)) return { kind: "DC0", text };
  const ac = /^(\d+(?:[.,]\d+)?)V?AC$|^AC(\d+(?:[.,]\d+)?)V?$|^(\d{3})V$/.exec(t);
  if (ac) return { kind: "L", volts: Number((ac[1] ?? ac[2] ?? ac[3]).replace(",", ".")), text };
  const neg = /^-(\d+(?:[.,]\d+)?)V(DC)?$/.exec(t);
  if (neg) return { kind: "DC-", volts: -Number(neg[1].replace(",", ".")), text };
  const dc = /^(?:\+|P)(\d+(?:[.,]\d+)?)V?(DC)?$|^(\d+(?:[.,]\d+)?)V(DC)?$|^(?:DC|L\+)(\d+(?:[.,]\d+)?)?V?$/.exec(t);
  if (dc) {
    const v = dc[1] ?? dc[3] ?? dc[5];
    return { kind: "DC+", volts: v ? Number(v.replace(",", ".")) : undefined, text };
  }
  return null;
}

function potentialOfFunction(fn: WireFunction | undefined): Potential | null {
  switch (fn) {
    case "L1":
    case "L2":
    case "L3":
    case "N":
    case "PE":
      return { kind: fn, text: fn };
    case "dc0V":
      return { kind: "DC0", text: "0 V DC" };
    default:
      return null;
  }
}

/** potentials a pin name implies (only unambiguous names) */
function potentialOfPin(name: string): Potential | null {
  const t = name.trim().toUpperCase();
  if (/^(PE|⏚|GND\/PE|PE\d?)$/.test(t)) return { kind: "PE", text: name };
  if (t === "N") return { kind: "N", text: name };
  if (/^(L1|L2|L3)$/.test(t)) return { kind: t as PotKind, text: name };
  if (/^(\+|\+24V?|24V\+?|L\+|V\+|\+V)$/.test(t)) return { kind: "DC+", text: name };
  if (/^(-|0V|M|L-|V-|-V|GND)$/.test(t)) return { kind: "DC0", text: name };
  return null;
}

const AC_KINDS: PotKind[] = ["L1", "L2", "L3", "L"];
const isLive = (k: PotKind) => AC_KINDS.includes(k) || k === "DC+" || k === "DC-";

/** why two potentials on one conductor are a short circuit (null = compatible) */
export function conflict(a: Potential, b: Potential): string | null {
  const [x, y] = [a.kind, b.kind];
  if (x === y) {
    if ((x === "DC+" || x === "DC-" || x === "L") && a.volts !== undefined && b.volts !== undefined && a.volts !== b.volts) return `${a.text} and ${b.text} are different voltages`;
    return null;
  }
  const pair = (p: PotKind, q: PotKind) => (x === p && y === q) || (x === q && y === p);
  if (pair("PEN", "N") || pair("PEN", "PE")) return null;
  // PELV: the 0 V of a control circuit may be bonded to PE (IEC 60204-1 9.4.3)
  if (pair("PE", "DC0")) return null;
  // an unspecified phase "L" matches any of L1…L3
  if ((x === "L" && AC_KINDS.includes(y)) || (y === "L" && AC_KINDS.includes(x))) return null;
  if ((x === "PE" || x === "PEN") && isLive(y)) return `protective earth is connected to live conductor ${b.text}`;
  if ((y === "PE" || y === "PEN") && isLive(x)) return `protective earth is connected to live conductor ${a.text}`;
  if (AC_KINDS.includes(x) && AC_KINDS.includes(y)) return `phases ${a.text} and ${b.text} are joined (phase-to-phase short)`;
  if (pair("N", "L1") || pair("N", "L2") || pair("N", "L3") || pair("N", "L")) return `phase and neutral are joined (${a.text} / ${b.text})`;
  if (pair("DC+", "DC0") || pair("DC-", "DC0") || pair("DC+", "DC-")) return `DC supply is shorted (${a.text} / ${b.text})`;
  if ((AC_KINDS.includes(x) || x === "N") && (y.startsWith("DC") || y === "PE")) return `AC conductor ${a.text} meets ${b.text}`;
  if ((AC_KINDS.includes(y) || y === "N") && (x.startsWith("DC") || x === "PE")) return `AC conductor ${b.text} meets ${a.text}`;
  return `${a.text} and ${b.text} are different potentials`;
}

/* ------------------------------------------------------------------ */
/* Project nets                                                         */
/* ------------------------------------------------------------------ */

class DSU {
  p = new Map<string, string>();
  find(x: string): string {
    let r = x;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!;
    let c = x;
    while (c !== r) {
      const n = this.p.get(c)!;
      this.p.set(c, r);
      c = n;
    }
    if (!this.p.has(r)) this.p.set(r, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

export type PinRef = { el: string; pin: string; pageId: string };
export type ProjectNet = {
  id: string;
  pins: PinRef[];
  wires: { id: string; pageId: string }[];
  labels: string[];
  potentials: (Potential & { from: "label" | "function"; wire: string })[];
  sections: { wire: string; mm2: number; text: string }[];
};

const isReport = (d: ElementDef | undefined) => d?.linkType === "next_report" || d?.linkType === "previous_report";
const textOf = (d: ElementDef) => [d.name, ...Object.values(d.names ?? {}), d.category].join(" ").toLowerCase();
export const isTerminal = (d: ElementDef | undefined) => !!d && (d.linkType === "terminal" || (/terminal|borne|klemme|reihenklemme/.test(textOf(d)) && !isConnector(d)));
const isJunctionEl = (d: ElementDef | undefined) => d?.name === "volt_junction";
const SPLICE = /splice|junction|jonction|connection point|connexion|abzweig|verbindungspunkt|\bnode\b|bridge|jumper|br[üu]cke|cavalier|pont/;
/** elements whose pins are one conductor: splices / junctions, bridges, feed-through terminals */
function joinsPins(d: ElementDef): boolean {
  if (isJunctionEl(d) || SPLICE.test(textOf(d))) return true;
  if (!isTerminal(d)) return false;
  if (d.pins.length === 2) return true;
  // multi-pin terminals: one potential unless the pins are numbered differently (multi-level terminals)
  return new Set(d.pins.map((p) => (p.number || p.name || "").trim().toLowerCase())).size <= 1;
}

export type ElIndex = Map<string, { e: ElemInst; page: Page; def: ElementDef | undefined }>;
export function indexElements(doc: Doc): ElIndex {
  const m: ElIndex = new Map();
  for (const page of doc.pages) if (!page.archived) for (const e of page.elements) m.set(e.id, { e, page, def: doc.defs[e.defId] });
  return m;
}

export function projectNets(doc: Doc, idx: ElIndex = indexElements(doc)): { nets: ProjectNet[]; netOfPin: Map<string, ProjectNet>; netOfWire: Map<string, ProjectNet> } {
  const d = new DSU();
  const pinKey = (el: string, pin: string) => `p:${el}/${pin}`;
  const touched = new Set<string>();
  const pages = doc.pages.filter((p) => !p.archived && p.kind !== "cover" && p.kind !== "contents");
  for (const page of pages)
    for (const w of page.wires) {
      const wk = `w:${w.id}`;
      d.find(wk);
      for (const end of [w.a, w.b]) {
        const k = end.k === "pin" ? pinKey(end.el, end.pin) : end.k === "junction" ? `j:${end.j}` : null;
        if (k) (d.union(wk, k), touched.add(k));
      }
    }
  for (const [, { e, def }] of idx) {
    if (!def) continue;
    // mated connectors (any pages)
    if (e.mate?.gender === "male") {
      const o = idx.get(e.mate.id);
      if (o?.def) for (const p of matedPinPairs(def, o.def)) d.union(pinKey(e.id, p.a), pinKey(o.e.id, p.b));
    }
    // folio reports: the arrow and its counterpart are one conductor
    if (isReport(def))
      for (const l of e.links ?? []) {
        const o = idx.get(l);
        if (!o?.def) continue;
        for (const pa of def.pins) for (const pb of o.def.pins) d.union(pinKey(e.id, pa.id), pinKey(o.e.id, pb.id));
      }
    // feed-through terminals (2 pins) and junction elements join their pins
    if (joinsPins(def)) for (let i = 1; i < def.pins.length; i++) d.union(pinKey(e.id, def.pins[0].id), pinKey(e.id, def.pins[i].id));
  }
  const byRoot = new Map<string, ProjectNet>();
  const net = (k: string) => {
    const r = d.find(k);
    let n = byRoot.get(r);
    if (!n) byRoot.set(r, (n = { id: `n${byRoot.size + 1}`, pins: [], wires: [], labels: [], potentials: [], sections: [] }));
    return n;
  };
  const netOfPin = new Map<string, ProjectNet>();
  const netOfWire = new Map<string, ProjectNet>();
  for (const page of pages)
    for (const w of page.wires) {
      const n = net(`w:${w.id}`);
      n.wires.push({ id: w.id, pageId: page.id });
      netOfWire.set(w.id, n);
      const label = w.label?.trim();
      if (label && !n.labels.some((x) => x.toLowerCase() === label.toLowerCase())) n.labels.push(label);
      const pl = potentialOfLabel(label);
      if (pl) n.potentials.push({ ...pl, from: "label", wire: w.id });
      const pf = potentialOfFunction(w.fn);
      if (pf) n.potentials.push({ ...pf, from: "function", wire: w.id });
      const info = wireInfo(doc, w);
      const mm2 = sectionMm2(info.section);
      if (mm2 !== null) n.sections.push({ wire: w.id, mm2, text: info.section! });
    }
  for (const [, { e, page, def }] of idx) {
    if (!def || isJunctionEl(def)) continue;
    for (const p of def.pins) {
      const k = pinKey(e.id, p.id);
      // pins without wires belong to a net only through a mate / report / terminal link to wired pins
      if (!touched.has(k) && !d.p.has(k)) continue;
      const n = net(k);
      n.pins.push({ el: e.id, pin: p.id, pageId: page.id });
      netOfPin.set(`${e.id}/${p.id}`, n);
    }
  }
  const nets = [...byRoot.values()].filter((n) => n.wires.length || n.pins.length > 1);
  return { nets, netOfPin, netOfWire };
}

/* ------------------------------------------------------------------ */
/* Cross-sections                                                       */
/* ------------------------------------------------------------------ */

/**
 * Approximate current-carrying capacity (A) of PVC-insulated copper conductors, two loaded
 * conductors, 40 °C ambient, installation method B2 (conductors in conduit / trunking) —
 * IEC 60204-1:2016 Table 6. Derating for grouping and temperature still applies.
 */
const AMPACITY: [number, number][] = [
  [0.2, 3], [0.34, 4.5], [0.5, 6], [0.75, 8.5], [1, 10.1], [1.5, 13.1], [2.5, 17.4], [4, 23], [6, 30], [10, 40], [16, 54], [25, 70], [35, 86], [50, 103], [70, 130], [95, 156], [120, 179],
  [150, 200], [185, 225], [240, 265],
];
export function ampacity(mm2: number): number {
  let best = 0;
  for (const [s, a] of AMPACITY) if (mm2 >= s - 1e-6) best = a;
  return best;
}
/** smallest standard section able to carry `amps` (method B2) */
export function sectionFor(amps: number): number | null {
  return AMPACITY.find(([, a]) => a >= amps)?.[0] ?? null;
}
/** required PE section for a phase section (IEC 60364-5-54 Table 54.2 / IEC 60204-1 Table 1) */
export function requiredPe(phase: number): number {
  return phase <= 16 ? phase : phase <= 35 ? 16 : phase / 2;
}
const fmtS = (n: number) => `${String(Math.round(n * 100) / 100)} mm²`;

/** rated current of a protective device from its rating text ("16A", "C16", "10 A gG", "B6") */
export function ratedCurrent(e: ElemInst): number | null {
  const s = [e.info.rating, e.info.description, e.info.designation, e.info.manufacturer_reference, e.info.comment].filter(Boolean).join(" ");
  const a = /(\d+(?:[.,]\d+)?)\s*A\b/i.exec(s) ?? /\b[BCDKZ]\s?(\d+(?:[.,]\d+)?)\b/.exec(s);
  return a ? Number(a[1].replace(",", ".")) : null;
}

const PROTECTIVE = /fuse|breaker|mcb|mpcb|rcbo|disjoncteur|fusible|sicherung|leitungsschutz|leistungsschalter|schutzschalter|motor ?protect|overcurrent|circuit[- ]protect/;
const isProtective = (d: ElementDef) => PROTECTIVE.test(textOf(d));
const MOTOR = /\bmotor\b|moteur|\bm3~|\bmotor[- ]?3/;
const isMotor = (d: ElementDef, e: ElemInst) => MOTOR.test(textOf(d)) || /^-?M\d/i.test(e.info.label ?? "");
const EQUIPMENT_NEEDS_PE = /motor|moteur|drive|inverter|vfd|frequen|servo|power supply|alimentation|netzteil|transformer|transfo|heater|pump|fan|cabinet|enclosure/;
const ESTOP = /emergency|e-?stop|estop|arr[êe]t d.?urgence|not-?halt|not-?aus|emergenc/;

/* ------------------------------------------------------------------ */
/* The check                                                            */
/* ------------------------------------------------------------------ */

export function checkElectrical(doc: Doc): ErcFinding[] {
  const out: ErcFinding[] = [];
  const idx = indexElements(doc);
  const { nets, netOfPin } = projectNets(doc, idx);
  const wireById = new Map<string, { w: Wire; page: Page }>();
  for (const page of doc.pages) if (!page.archived) for (const w of page.wires) wireById.set(w.id, { w, page });
  const elName = (id: string) => {
    const x = idx.get(id);
    return x ? x.e.info.label?.trim() || x.def?.name || "component" : "component";
  };
  const pinName = (el: string, pin: string) => {
    const x = idx.get(el);
    const p = x?.def?.pins.find((q) => q.id === pin);
    return `${elName(el)}:${p?.number || p?.name || "?"}`;
  };
  const wireName = (id: string) => {
    const w = wireById.get(id)?.w;
    return w?.label ? `wire ${w.label}` : "a wire";
  };
  const elAnchor = (id: string): ErcFinding["anchor"] => {
    const x = idx.get(id);
    return x ? { type: "element", id, x: x.e.x, y: x.e.y } : undefined;
  };
  const wireAnchor = (id: string): ErcFinding["anchor"] => {
    const x = wireById.get(id);
    if (!x || !x.w.pts.length) return undefined;
    const a = x.w.pts[Math.floor((x.w.pts.length - 1) / 2)], b = x.w.pts[Math.min(x.w.pts.length - 1, Math.floor((x.w.pts.length - 1) / 2) + 1)];
    return { type: "wire", id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const onWire = (f: Omit<ErcFinding, "anchor" | "pageId">, wire: string) => out.push({ ...f, pageId: wireById.get(wire)?.page.id, anchor: wireAnchor(wire) });
  const onEl = (f: Omit<ErcFinding, "anchor" | "pageId">, el: string) => out.push({ ...f, pageId: idx.get(el)?.page.id, anchor: elAnchor(el) });

  /* ---------- short circuits / conflicting potentials ---------- */
  for (const n of nets) {
    // a single wire marked inconsistently (label says N, function says L1)
    const perWire = new Map<string, ProjectNet["potentials"]>();
    for (const p of n.potentials) perWire.set(p.wire, [...(perWire.get(p.wire) ?? []), p]);
    const inconsistent = new Set<string>();
    for (const [wid, ps] of perWire) {
      const lab = ps.find((p) => p.from === "label"), fn = ps.find((p) => p.from === "function");
      if (lab && fn && conflict(lab, fn)) {
        inconsistent.add(wid);
        onWire(
          { level: "error", code: "erc.markingMismatch", category: "wiring", message: `${wireName(wid)} is labelled "${lab.text}" but its circuit function is ${fn.text}`, suggestion: "Correct the wire number or the circuit function so the marking and the colour match the real potential.", ids: [wid] },
          wid,
        );
      }
    }
    const seen = new Set<string>();
    for (let i = 0; i < n.potentials.length; i++)
      for (let j = i + 1; j < n.potentials.length; j++) {
        const a = n.potentials[i], b = n.potentials[j];
        if (a.wire === b.wire && inconsistent.has(a.wire)) continue;
        const why = conflict(a, b);
        if (!why) continue;
        const key = [a.kind + (a.volts ?? ""), b.kind + (b.volts ?? "")].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const pe = why.includes("protective earth");
        onWire(
          {
            level: "error",
            code: pe ? "erc.peLive" : "erc.short",
            category: pe ? "safety" : "short",
            message: `Short circuit: ${why}. One conductor carries ${wireName(a.wire)} and ${wireName(b.wire)}${n.pins.length ? ` (connects ${n.pins.slice(0, 4).map((p) => pinName(p.el, p.pin)).join(", ")}${n.pins.length > 4 ? "…" : ""})` : ""}.`,
            suggestion: pe ? "Separate the protective conductor from live conductors; PE must never carry operating current." : "Find where the two potentials meet (a wire drawn to the wrong terminal, a shared junction or a mislabelled rail) and separate them.",
            ids: [a.wire, ...(b.wire !== a.wire ? [b.wire] : [])],
          },
          a.wire,
        );
      }
  }

  /* ---------- component bypassed: two of its pins on one conductor ---------- */
  for (const [id, { e, def }] of idx) {
    if (!def || def.pins.length < 2 || isTerminal(def) || joinsPins(def) || isReport(def) || isConnector(def)) continue;
    if (/shunt|\blink\b/.test(textOf(def))) continue;
    const groups = new Map<ProjectNet, string[]>();
    for (const p of def.pins) {
      const n = netOfPin.get(`${id}/${p.id}`);
      if (n) groups.set(n, [...(groups.get(n) ?? []), p.id]);
    }
    for (const [, pins] of groups) {
      if (pins.length < 2) continue;
      const pdefs = pins.map((pid) => def.pins.find((p) => p.id === pid)!);
      // pins with the same number/name are internally the same terminal (e.g. two "PE" points)
      // unnumbered pins say nothing about the device's internals: only numbered / named terminals count
      if (pdefs.some((p) => !(p.number || p.name).trim())) continue;
      const keys = new Set(pdefs.map((p) => (p.number || p.name).trim().toLowerCase()));
      if (keys.size < 2) continue;
      const crit = isProtective(def) || /coil|bobine|spule|supply|alimentation|motor|moteur/.test(textOf(def));
      onEl(
        {
          level: crit ? "error" : "warning",
          code: "erc.selfShort",
          category: "short",
          message: `${elName(id)}: terminals ${pdefs.map((p) => p.number || p.name).join(" and ")} are wired to the same conductor — the ${isProtective(def) ? "protective device is bypassed" : "component is short-circuited / bypassed"}`,
          suggestion: "Check the wiring at this component: each terminal should go to its own circuit.",
          ids: [id],
        },
        id,
      );
    }
  }

  /* ---------- pins whose name implies a potential ---------- */
  for (const [id, { e, def }] of idx) {
    if (!def || isReport(def) || isJunctionEl(def)) continue;
    for (const p of def.pins) {
      const want = potentialOfPin(p.name || p.number);
      if (!want) continue;
      const n = netOfPin.get(`${id}/${p.id}`);
      if (!n) {
        if (want.kind === "PE" && !isTerminal(def) && !isConnector(def)) {
          const crit = EQUIPMENT_NEEDS_PE.test(textOf(def)) || isMotor(def, e);
          onEl(
            { level: crit ? "error" : "warning", code: "erc.peOpen", category: "safety", message: `${elName(id)}: protective earth terminal ${p.number || p.name} is not connected`, suggestion: "Connect the PE terminal to the protective bonding circuit (IEC 60204-1 8.2 / IEC 60364-5-54).", ids: [id] },
            id,
          );
        }
        continue;
      }
      const hard = n.potentials.find((q) => conflict(q, want) !== null);
      if (!hard) continue;
      const peInvolved = want.kind === "PE" || hard.kind === "PE";
      const reverse = (want.kind === "DC+" && hard.kind === "DC0") || (want.kind === "DC0" && hard.kind === "DC+");
      onEl(
        {
          level: peInvolved || reverse ? "error" : "warning",
          code: reverse ? "erc.polarity" : peInvolved ? "erc.peLive" : "erc.pinPotential",
          category: peInvolved ? "safety" : "wiring",
          message: reverse
            ? `${elName(id)}: terminal ${p.name || p.number} is wired to ${hard.text} — reversed polarity`
            : `${elName(id)}: terminal ${p.name || p.number} (${want.text}) is wired to ${hard.text}`,
          suggestion: reverse ? "Swap the + and 0 V conductors at this device." : peInvolved ? "Protective earth terminals connect only to PE." : "Check the conductor landed on this terminal; the terminal marking and the wire potential disagree.",
          ids: [id, hard.wire],
        },
        id,
      );
    }
  }

  /* ---------- connections ---------- */
  for (const [id, { e, page, def }] of idx) {
    if (!def || isJunctionEl(def) || !def.pins.length || page.kind === "cover" || page.kind === "contents") continue;
    if (isReport(def)) {
      if (!e.links?.length || !e.links.some((l) => idx.has(l)))
        onEl({ level: "error", code: "erc.reportOpen", category: "connection", message: `Folio report arrow${e.info.label ? ` ${e.info.label}` : ""} on "${page.title}" is not linked to a counterpart — the conductor ends here`, suggestion: "Link the report arrow to its continuation on the other sheet.", ids: [id] }, id);
      continue;
    }
    const wired = def.pins.filter((p) => netOfPin.has(`${id}/${p.id}`));
    if (!wired.length && !isTerminal(def) && !e.mate)
      onEl({ level: "info", code: "erc.unwired", category: "connection", message: `${elName(id)} on "${page.title}" has no connections`, suggestion: "Wire it, or remove it if it is not part of the circuit.", ids: [id] }, id);
    if (def.linkType === "slave" && !e.links?.some((l) => idx.has(l)))
      onEl({ level: "warning", code: "erc.slaveOrphan", category: "connection", message: `Contact ${elName(id)} is not linked to a coil / master device`, suggestion: "Link the contact to the relay, contactor or switch that operates it so the cross-reference is correct.", ids: [id] }, id);
    if (def.linkType === "master" && !e.links?.some((l) => idx.has(l)) && wired.length)
      onEl({ level: "info", code: "erc.masterNoSlaves", category: "connection", message: `${elName(id)} has no contacts drawn or linked`, suggestion: "Draw / link the contacts it switches, or confirm it is used only via external wiring.", ids: [id] }, id);
  }
  for (const n of nets) {
    // a conductor that reaches exactly one terminal and no other one (and no free end, which validation reports)
    if (n.pins.length !== 1 || !n.wires.length) continue;
    const free = n.wires.some((w) => {
      const x = wireById.get(w.id)?.w;
      return x && (x.a.k === "free" || x.b.k === "free");
    });
    if (free) continue;
    const only = n.pins[0];
    if (isReport(idx.get(only.el)?.def)) continue;
    onWire({ level: "warning", code: "erc.deadEnd", category: "connection", message: `The conductor from ${pinName(only.el, only.pin)} does not reach any other terminal`, suggestion: "Connect it to its destination or add a folio report to the sheet it continues on.", ids: [n.wires[0].id, only.el] }, n.wires[0].id);
  }

  /* ---------- naming ---------- */
  for (const [id, { e, def }] of idx) {
    if (!def || isReport(def) || isJunctionEl(def)) continue;
    const label = e.info.label?.trim();
    if (!label) continue;
    const local = label.includes("-") ? label.slice(label.lastIndexOf("-") + 1) : label.replace(/^[=+].*?(?=[A-Za-z]+\d)/, "");
    const m = /^([A-Za-z]+)/.exec(local);
    const want = prefixFor(doc, def).replace(/^-/, "");
    const have = m?.[1].toUpperCase() ?? "";
    const W = want.toUpperCase();
    // multi-letter codes (QF, KA) and the Q/F split for circuit-breakers are common practice
    const tolerated = !have || !W || have.includes(W) || W.includes(have) || (isProtective(def) && /^[QF]/.test(have));
    if (m && want && /^[A-Za-z]+$/.test(want) && !tolerated)
      onEl(
        { level: "warning", code: "erc.prefix", category: "naming", message: `${label}: the reference letter "${m[1]}" does not match the component class (${def.name} → "${want}")`, suggestion: `Rename it ${want}${local.slice(m[1].length)} (IEC 81346-2 letter codes), or fix the numbering rule if this class is intended.`, ids: [id] },
        id,
      );
    if (/\s/.test(label) || (m && m[1] !== m[1].toUpperCase()))
      onEl({ level: "info", code: "erc.refFormat", category: "naming", message: `Reference "${label}" contains spaces or lower-case letters`, suggestion: "Use upper-case letter codes without spaces (e.g. -K1, =A1+B2-K1).", ids: [id] }, id);
  }
  const labelNets = new Map<string, ProjectNet[]>();
  // with automatic wire numbering, segment letters (B012A, B012B) belong to one circuit
  const wn = wireNumberingOf(doc);
  const circuit = (l: string) => (doc.wireNumbering ? circuitKey(l, wn) ?? l : l);
  for (const n of nets) {
    const numbers = [...new Map(n.labels.filter((l) => !potentialOfLabel(l)).map((l) => [circuit(l).toLowerCase(), l])).values()];
    if (numbers.length > 1)
      onWire(
        { level: "warning", code: "erc.multiNumber", category: "naming", message: `One conductor carries several wire numbers: ${numbers.join(", ")}`, suggestion: "A conductor (everything joined without a device in between) should have one wire number. Renumber the segments, or check for an unintended connection.", ids: n.wires.map((w) => w.id).slice(0, 20) },
        n.wires[0].id,
      );
    for (const l of numbers) labelNets.set(circuit(l).toLowerCase(), [...(labelNets.get(circuit(l).toLowerCase()) ?? []), n]);
  }
  for (const [l, list] of labelNets) {
    if (list.length < 2 || !/[a-z0-9]/i.test(l)) continue;
    const label = wireById.get(list[0].wires[0].id)?.w.label ?? "";
    onWire(
      { level: "info", code: "erc.numberReuse", category: "naming", message: `Wire number ${label} is used on ${list.length} conductors that are not connected in the drawing`, suggestion: "If they are the same potential, connect them (folio reports, terminals); otherwise give each conductor its own number.", ids: list.flatMap((n) => n.wires.map((w) => w.id)).slice(0, 20) },
      list[1].wires[0].id,
    );
  }

  /* ---------- colours ---------- */
  const std = wiringOf(doc).standard;
  for (const [wid, { w }] of wireById) {
    const info = wireInfo(doc, w);
    const code = info.look?.code ?? colorOf(info.color)?.code;
    if (!code || info.colorSource === "standard") continue;
    const kind = potentialOfFunction(w.fn)?.kind ?? potentialOfLabel(w.label)?.kind;
    if (std === "iec" && kind === "N" && !["BU", "LBU"].includes(code))
      onWire({ level: "warning", code: "erc.nColor", category: "wiring", message: `Neutral conductor${w.label ? ` ${w.label}` : ""} is ${code}; IEC 60445 / 60204-1 require light blue`, suggestion: "Use a light-blue (LBU) conductor for N.", ids: [wid] }, wid);
    if (std === "iec" && kind && AC_KINDS.includes(kind) && ["BU", "LBU", "GNYE"].includes(code))
      onWire({ level: "error", code: "erc.phaseColor", category: "safety", message: `Phase conductor${w.label ? ` ${w.label}` : ""} is ${code} — blue is reserved for neutral${code === "GNYE" ? " and green-yellow for PE" : ""}`, suggestion: "Use BN / BK / GY (or BK for all phases per IEC 60204-1) for phase conductors.", ids: [wid] }, wid);
  }

  /* ---------- cross-sections ---------- */
  const powerFn: WireFunction[] = ["power", "L1", "L2", "L3", "N"];
  const controlFn: WireFunction[] = ["acControl", "dcControl", "dc0V", "interlock"];
  let missingPower = 0;
  let firstMissing: string | null = null;
  const anySection = [...wireById.values()].some(({ w }) => wireInfo(doc, w).section);
  for (const [wid, { w }] of wireById) {
    const s = sectionMm2(wireInfo(doc, w).section);
    if (s === null) {
      if (w.fn && powerFn.includes(w.fn)) (missingPower++, (firstMissing ??= wid));
      continue;
    }
    if (w.fn && powerFn.includes(w.fn) && s < 0.75)
      onWire({ level: "warning", code: "erc.sectionMinPower", category: "section", message: `Power conductor${w.label ? ` ${w.label}` : ""} is ${fmtS(s)} — below the 0.75 mm² minimum for power circuits (IEC 60204-1 Table 5)`, suggestion: "Use at least 0.75 mm² (1.5 mm² is typical for power wiring).", ids: [wid] }, wid);
    if (w.fn && controlFn.includes(w.fn) && s < 0.2)
      onWire({ level: "warning", code: "erc.sectionMinControl", category: "section", message: `Control conductor${w.label ? ` ${w.label}` : ""} is ${fmtS(s)} — below the 0.2 mm² minimum (IEC 60204-1 Table 5)`, suggestion: "Use at least 0.2 mm² inside enclosures (0.5–0.75 mm² is common).", ids: [wid] }, wid);
  }
  if (missingPower && anySection && firstMissing)
    onWire({ level: "info", code: "erc.sectionMissing", category: "section", message: `${missingPower} power conductor${missingPower === 1 ? " has" : "s have"} no cross-section`, suggestion: "Specify the cross-section of every power conductor so sizing can be checked and the wiring list is complete.", ids: [firstMissing] }, firstMissing);
  for (const n of nets) {
    if (n.sections.length < 2) continue;
    const min = n.sections.reduce((a, b) => (b.mm2 < a.mm2 ? b : a));
    const max = n.sections.reduce((a, b) => (b.mm2 > a.mm2 ? b : a));
    if (max.mm2 > min.mm2 + 1e-6)
      onWire(
        { level: "warning", code: "erc.sectionStep", category: "section", message: `The conductor changes from ${fmtS(max.mm2)} to ${fmtS(min.mm2)} with no protective device in between`, suggestion: `A reduced cross-section needs its own overcurrent protection (IEC 60364-4-43 433.2), or size all segments ${fmtS(max.mm2)}.`, ids: [min.wire, max.wire] },
        min.wire,
      );
  }
  // protective device rating vs the conductors it protects
  for (const [id, { e, def }] of idx) {
    if (!def || !isProtective(def)) continue;
    const In = ratedCurrent(e);
    if (!In) {
      if (def.pins.some((p) => netOfPin.has(`${id}/${p.id}`)))
        onEl({ level: "info", code: "erc.ratingMissing", category: "section", message: `${elName(id)}: protective device without a rated current`, suggestion: "Enter the rating (e.g. C16 or 10 A gG) so conductor protection can be checked.", ids: [id] }, id);
      continue;
    }
    const worst = new Map<string, { mm2: number; text: string }>();
    for (const p of def.pins) {
      const n = netOfPin.get(`${id}/${p.id}`);
      for (const s of n?.sections ?? []) if (!worst.has(s.wire) && ampacity(s.mm2) < In) worst.set(s.wire, s);
    }
    if (!worst.size) continue;
    const [wid, s] = [...worst.entries()].sort((a, b) => a[1].mm2 - b[1].mm2)[0];
    const need = sectionFor(In);
    onEl(
      {
        level: "error",
        code: "erc.overcurrent",
        category: "section",
        message: `${elName(id)} (${In} A) protects ${fmtS(s.mm2)} conductors that carry only about ${ampacity(s.mm2)} A (IEC 60204-1 Table 6, PVC Cu, method B2)`,
        suggestion: `Increase the conductors to ${need ? fmtS(need) : "a larger section"} or reduce the device to ≤ ${ampacity(s.mm2)} A. Check derating for grouping and ambient temperature.`,
        ids: [id, ...worst.keys()],
      },
      id,
    );
    void wid;
  }
  // PE section against the phase conductors at each device
  for (const [id, { def }] of idx) {
    if (!def || isTerminal(def) || isReport(def) || isJunctionEl(def)) continue;
    let phase = 0, pe: { mm2: number; wire: string } | null = null;
    for (const p of def.pins) {
      const n = netOfPin.get(`${id}/${p.id}`);
      if (!n) continue;
      const kinds = new Set(n.potentials.map((q) => q.kind));
      const pinPe = potentialOfPin(p.name || p.number)?.kind === "PE";
      for (const s of n.sections) {
        if (kinds.has("PE") || pinPe) pe = !pe || s.mm2 < pe.mm2 ? { mm2: s.mm2, wire: s.wire } : pe;
        else if ([...kinds].some((k) => AC_KINDS.includes(k))) phase = Math.max(phase, s.mm2);
      }
    }
    if (pe && phase && pe.mm2 + 1e-6 < requiredPe(phase))
      onEl(
        { level: "warning", code: "erc.peSection", category: "section", message: `${elName(id)}: PE conductor ${fmtS(pe.mm2)} is smaller than required for ${fmtS(phase)} phase conductors (${fmtS(requiredPe(phase))})`, suggestion: "Size the protective conductor per IEC 60364-5-54 Table 54.2 / IEC 60204-1 Table 1.", ids: [id, pe.wire] },
        id,
      );
  }

  /* ---------- safety ---------- */
  for (const [id, { e, def }] of idx) {
    if (!def || !ESTOP.test(textOf(def) + " " + (e.info.description ?? "").toLowerCase())) continue;
    const used = def.pins.filter((p) => netOfPin.has(`${id}/${p.id}`)).map((p) => p.number);
    const no = used.filter((n) => /^\d*[34]$/.test(n ?? ""));
    if (no.length >= 2 && !used.some((n) => /^\d*[12]$/.test(n ?? "")))
      onEl(
        { level: "error", code: "erc.estopNO", category: "safety", message: `Emergency stop ${elName(id)} is wired on normally-open terminals ${no.join("-")}`, suggestion: "Use the direct-opening normally-closed contact (x1-x2) so a broken wire stops the machine (ISO 13850, IEC 60947-5-5).", ids: [id] },
        id,
      );
  }
  const kinds = new Set(nets.flatMap((n) => n.potentials.map((p) => p.kind)));
  const all = [...idx.values()];
  const anyText = (re: RegExp) => all.some(({ def, e }) => def && re.test(textOf(def) + " " + (e.info.description ?? "").toLowerCase()));
  const threePhase = kinds.has("L1") && kinds.has("L2") && kinds.has("L3");
  if (threePhase && !anyText(/main switch|disconnect|isolat|sectionneur|hauptschalter|interrupteur|load break|lasttrenn|switch.?disconnector/)) {
    const first = nets.find((n) => n.potentials.some((p) => p.kind === "L1"))!;
    onWire({ level: "warning", code: "erc.noIsolator", category: "safety", message: "The drawing has a three-phase supply but no supply-disconnecting device (main switch / isolator) was found", suggestion: "Provide a lockable supply-disconnecting device (IEC 60204-1 5.3).", ids: [first.wires[0].id] }, first.wires[0].id);
  }
  const motors = all.filter(({ def, e }) => def && isMotor(def, e));
  if (motors.length && !anyText(/overload|thermal|motor ?protect|mpcb|relais thermique|motorschutz|thermique|drive|inverter|vfd|frequen|soft ?start|servo/))
    for (const m of motors.slice(0, 10))
      onEl({ level: "warning", code: "erc.motorOverload", category: "safety", message: `Motor ${elName(m.e.id)} has no overload protection in the drawing`, suggestion: "Add a motor-protective circuit breaker or overload relay sized to the motor's rated current (IEC 60204-1 7.3).", ids: [m.e.id] }, m.e.id);
  if (kinds.has("DC0") && kinds.has("PE") && !nets.some((n) => n.potentials.some((p) => p.kind === "DC0") && n.potentials.some((p) => p.kind === "PE"))) {
    const first = nets.find((n) => n.potentials.some((p) => p.kind === "DC0"))!;
    onWire({ level: "info", code: "erc.pelv", category: "safety", message: "The 0 V of the DC control supply is not bonded to PE", suggestion: "For PELV control circuits bond one side (0 V) to the protective bonding circuit, or document an insulation monitor (IEC 60204-1 9.4.3).", ids: [first.wires[0].id] }, first.wires[0].id);
  }

  const order: Record<ErcLevel, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/* ------------------------------------------------------------------ */
/* Netlist text for the AI reviewer                                     */
/* ------------------------------------------------------------------ */

export type NetlistKeys = { elements: Map<string, string>; wires: Map<string, string>; pages: Map<string, string> };

/**
 * Compact, model-friendly description of the project: pages, components (with key, reference,
 * symbol, ratings, pins), and every conductor with the terminals it joins, its numbers, function,
 * colour and cross-section. Keys (E12, W4, P2) map back to ids for anchoring comments.
 */
export function netlistText(doc: Doc, maxChars = 180_000): { text: string; keys: NetlistKeys; truncated: boolean } {
  const idx = indexElements(doc);
  const { nets } = projectNets(doc, idx);
  const keys: NetlistKeys = { elements: new Map(), wires: new Map(), pages: new Map() };
  const pages = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const lines: string[] = [];
  lines.push(`PROJECT "${doc.meta.title}" — wiring standard ${wiringOf(doc).standard.toUpperCase()}`);
  const props = Object.entries(doc.meta.props ?? {}).filter(([, v]) => v).slice(0, 30);
  if (props.length) lines.push(`Properties: ${props.map(([k, v]) => `${k}=${v}`).join("; ")}`);
  if (doc.cables?.length) lines.push(`Cables: ${doc.cables.map((c) => `${c.tag} ${c.cores.length}x${c.section ?? "?"} [${c.cores.map((k) => k.name + (k.color ? `/${k.color}` : "")).join(",")}]`).join("; ")}`);
  lines.push("", "PAGES");
  pages.forEach((p, i) => {
    const k = `P${i + 1}`;
    keys.pages.set(p.id, k);
    const notes = p.texts.map((t) => t.text.trim()).filter(Boolean).join(" | ").slice(0, 300);
    lines.push(`${k} "${p.title}"${p.kind && p.kind !== "drawing" ? ` (${p.kind})` : ""}${notes ? ` notes: ${notes}` : ""}`);
  });
  lines.push("", "COMPONENTS (key | page | reference | symbol [category] | link type | info | pins number:name)");
  let n = 0;
  for (const p of pages)
    for (const e of p.elements) {
      const def = doc.defs[e.defId];
      if (!def || isJunctionEl(def)) continue;
      const k = `E${++n}`;
      keys.elements.set(e.id, k);
      const info = Object.entries(e.info).filter(([key, v]) => v && key !== "label").map(([key, v]) => `${key}=${String(v).replace(/\s+/g, " ").slice(0, 80)}`).join("; ");
      const links = [...(e.links ?? []), ...(e.mate ? [e.mate.id] : [])];
      lines.push(
        `${k} | ${keys.pages.get(p.id)} | ${e.info.label || "-"} | ${def.name}${def.category ? ` [${def.category}]` : ""} | ${def.linkType || "simple"}${links.length ? ` linked:${links.length}` : ""}${e.mate ? ` mated(${e.mate.gender})` : ""} | ${info || "-"} | ${def.pins.map((q) => `${q.number || "?"}${q.name && q.name !== q.number ? ":" + q.name : ""}`).join(",")}`,
      );
    }
  lines.push("", "CONDUCTORS (net | wires key=number fn colour section | terminals joined as REF:pin@page)");
  let wn = 0;
  for (const net of nets) {
    const ws = net.wires.map(({ id, pageId }) => {
      const page = pages.find((p) => p.id === pageId)!;
      const w = page.wires.find((x) => x.id === id)!;
      const k = `W${++wn}`;
      keys.wires.set(id, k);
      const i = wireInfo(doc, w);
      return `${k}=${w.label || "·"}${w.fn ? ` ${w.fn}` : ""}${i.color ? ` ${i.color}` : ""}${i.section ? ` ${i.section}` : ""}${w.cable ? ` cable ${w.cable}:${w.core ?? "?"}` : ""}${w.a.k === "free" || w.b.k === "free" ? " FREE-END" : ""}`;
    });
    const pins = net.pins.map((p) => {
      const x = idx.get(p.el);
      const pd = x?.def?.pins.find((q) => q.id === p.pin);
      return `${x?.e.info.label || keys.elements.get(p.el) || "?"}:${pd?.number || pd?.name || "?"}@${keys.pages.get(p.pageId) ?? "?"}`;
    });
    lines.push(`${net.id} | ${ws.join(", ") || "-"} | ${pins.join(" ") || "-"}`);
  }
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n… (truncated: project too large, the rest was not sent)";
    truncated = true;
  }
  return { text, keys, truncated };
}
