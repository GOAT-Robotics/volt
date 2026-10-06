/**
 * Automatic wire numbering.
 *
 * Conductors are grouped into circuits (project-wide nets: wires joined directly, through
 * junctions, splices, feed-through terminals, mated connectors and folio reports). Every circuit
 * gets a class from its voltage system (A = 48 V DC, B = 24 V DC, C = 5 V DC … configurable) and a
 * number; with `segments` every physical wire of the circuit also gets a segment letter, so each
 * wire of a harness has a unique identifier:
 *
 *     B012A  B012B  B012C     24 V circuit 12, segments A–C
 *     B013AN                  its 0 V return (suffix N, as in SAE AS50881)
 *     PE01A                   protective earth
 *
 * The identifier structure follows SAE AS50881 (circuit function letter + circuit number + segment
 * letter [+ size] [+ N for returns]); IEC 60204-1 13.2.1 / IEC 62491 only require that every
 * conductor is identified at each termination consistently with the documentation, so the class
 * letters are the organisation's own. The panel preset numbers by sheet and column instead
 * ({class}{page}.{col}), the common EPLAN / IEC 61082 style.
 *
 * Classes are detected from: an explicit class on a wire, rail names and conductor functions (L1,
 * N, PE, +24V, 0V …), pin names, existing numbers, and then propagated through two-terminal devices
 * (fuses, contacts, switches, coils, loads) — but not through power supplies, converters or
 * multi-terminal modules, which separate voltage systems.
 *
 * Numbering is stable: by default existing numbers are kept and only new conductors and segments
 * get the next free numbers (harness labels are printed). "Renumber all" re-sequences everything
 * (closing gaps). Locked numbers are never touched.
 */
import type { Doc, ElementDef, Page, Wire, WireClass, WireFunction, WireNumbering } from "./model";
import { indexElements, isTerminal, potentialOfLabel, projectNets, type ElIndex, type Potential, type ProjectNet } from "./erc";
import { sectionMm2, AWG_SIZES, wireInfo, wiringOf } from "./wiring";

export const DEFAULT_CLASSES: WireClass[] = [
  { id: "48v", letter: "A", name: "48 V DC", kind: "dc", volts: 48 },
  { id: "24v", letter: "B", name: "24 V DC", kind: "dc", volts: 24 },
  { id: "5v", letter: "C", name: "5 V DC", kind: "dc", volts: 5 },
  { id: "12v", letter: "D", name: "12 V DC", kind: "dc", volts: 12 },
  { id: "3v3", letter: "E", name: "3.3 V DC", kind: "dc", volts: 3.3 },
  { id: "ac", letter: "X", name: "AC mains (230 / 400 V)", kind: "ac" },
  { id: "sig", letter: "S", name: "Signal / data (CAN, RS-485, Ethernet, encoder …)", kind: "signal", match: "CAN|RS-?485|RS-?232|ETH|TX|RX|SDA|SCL|ENC|SIG|DATA|USB|LIN|D\\+|D-" },
];

export const PRESETS: Record<"harness" | "panel", Omit<WireNumbering, "classes">> = {
  harness: { preset: "harness", format: "{class}{n:3}{seg}{ret}", segments: true, returnSuffix: "N", peLetter: "PE", fallbackLetter: "W", defaultDc: "24v", defaultAc: "ac", start: 1, replacePotentialNames: true },
  panel: { preset: "panel", format: "{class}{page}.{col}", segments: false, returnSuffix: "", peLetter: "PE", fallbackLetter: "W", defaultDc: "24v", defaultAc: "ac", start: 1, replacePotentialNames: false },
};

export function wireNumberingOf(doc: Pick<Doc, "wireNumbering">): WireNumbering {
  return doc.wireNumbering ?? { ...PRESETS.harness, classes: DEFAULT_CLASSES };
}

/* ------------------------------------------------------------------ */
/* Format                                                               */
/* ------------------------------------------------------------------ */

export type LabelParts = { cls: string; n?: number; seg: string; ret: boolean; page?: number; col?: number; row?: string; size?: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** letters a class can be written with, longest first (so "PE" wins over "P") */
function letters(cfg: WireNumbering) {
  return [...new Set([...cfg.classes.map((c) => c.letter), cfg.peLetter, cfg.fallbackLetter].filter(Boolean))].sort((a, b) => b.length - a.length);
}

type Parser = { re: RegExp; groups: (keyof LabelParts)[] };
const parsers = new WeakMap<WireNumbering, Parser>();
function parser(cfg: WireNumbering): Parser {
  const c = parsers.get(cfg);
  if (c) return c;
  const groups: (keyof LabelParts)[] = [];
  let re = "";
  const toks = cfg.format.split(/(\{[a-z]+(?::\d+)?\})/);
  for (const t of toks) {
    const m = /^\{([a-z]+)(?::\d+)?\}$/.exec(t);
    if (!m) {
      re += esc(t);
      continue;
    }
    switch (m[1]) {
      case "class":
        re += `(${letters(cfg).map(esc).join("|")})`;
        groups.push("cls");
        break;
      case "n":
        re += "(\\d+)";
        groups.push("n");
        break;
      case "seg":
        re += `([${SEG_ALPHABET}]{0,2})`;
        groups.push("seg");
        break;
      case "ret":
        re += cfg.returnSuffix ? `(${esc(cfg.returnSuffix)})?` : "()";
        groups.push("ret");
        break;
      case "page":
        re += "(\\d+)";
        groups.push("page");
        break;
      case "col":
        re += "(\\d+)";
        groups.push("col");
        break;
      case "row":
        re += "([A-Z])";
        groups.push("row");
        break;
      case "size":
        re += "([\\d./]*)";
        groups.push("size");
        break;
    }
  }
  // the panel format has no {n}: duplicates get ".2", ".3"
  const p = { re: new RegExp(`^${re}(?:\\.(\\d+))?$`), groups };
  parsers.set(cfg, p);
  return p;
}

/** split an identifier written in the configured format (null: not one of ours) */
export function parseWireLabel(label: string | undefined, cfg: WireNumbering): (LabelParts & { dup?: number }) | null {
  if (!label) return null;
  const { re, groups } = parser(cfg);
  const m = re.exec(label.trim());
  if (!m) return null;
  const out: LabelParts & { dup?: number } = { cls: "", seg: "", ret: false };
  groups.forEach((g, i) => {
    const v = m[i + 1];
    if (g === "n" || g === "page" || g === "col") (out as Record<string, unknown>)[g] = v === undefined ? undefined : Number(v);
    else if (g === "ret") out.ret = !!v;
    else (out as Record<string, unknown>)[g] = v ?? "";
  });
  if (m[groups.length + 1]) out.dup = Number(m[groups.length + 1]);
  return out;
}

/** the circuit part of an identifier (segment letter and duplicate suffix removed) */
export function circuitKey(label: string | undefined, cfg: WireNumbering): string | null {
  const p = parseWireLabel(label, cfg);
  if (!p) return null;
  return `${p.cls}|${p.n ?? ""}|${p.page ?? ""}|${p.col ?? ""}|${p.row ?? ""}|${p.ret ? "N" : ""}|${p.dup ?? ""}`;
}

export function formatWireLabel(cfg: WireNumbering, p: LabelParts): string {
  return cfg.format.replace(/\{([a-z]+)(?::(\d+))?\}/g, (_, k: string, w?: string) => {
    switch (k) {
      case "class":
        return p.cls;
      case "n":
        return p.n === undefined ? "" : w ? String(p.n).padStart(Number(w), "0") : String(p.n);
      case "seg":
        return cfg.segments ? p.seg : "";
      case "ret":
        return p.ret ? cfg.returnSuffix : "";
      case "page":
        return p.page === undefined ? "" : String(p.page);
      case "col":
        return p.col === undefined ? "" : String(p.col);
      case "row":
        return p.row ?? "";
      case "size":
        return p.size ?? "";
      default:
        return "";
    }
  });
}

/**
 * Segment letters A, B … Z, AA, AB … without I and O (read as 1 and 0) and without N (the return
 * suffix), as on aircraft / vehicle harnesses.
 */
export const SEG_ALPHABET = "ABCDEFGHJKLMPQRSTUVWXYZ";
export function segLetter(i: number): string {
  const L = SEG_ALPHABET.length;
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % L;
    s = SEG_ALPHABET[r] + s;
    n = Math.floor((n - 1) / L);
  }
  return s;
}
const segIndex = (s: string) => [...s].reduce((a, ch) => a * SEG_ALPHABET.length + (SEG_ALPHABET.indexOf(ch) + 1), 0) - 1;

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

export type NetClass = { classId: string | null; letter: string; isReturn: boolean; isPe: boolean; source: string; conflict?: string };

const MULTI_POTENTIAL = /power supply|psu|alimentation|netzteil|converter|dc\/dc|dc-dc|transformer|transfo|regulator|ldo|buck|boost|inverter|drive|vfd|servo|plc|controller|module|i\/o|io-link|ecu|mcu|board|pcb|relay module|gateway|bms|battery|charger/;

const pinKeyOf = (def: ElementDef, pinId: string) => {
  const p = def.pins.find((x) => x.id === pinId);
  return (p?.number || p?.name || pinId).trim().toUpperCase();
};

/** pairs of pins of one device that carry the same circuit (1-2, 3-4, 13-14, 21-22, A1-A2 …) */
function passPairs(def: ElementDef, connected: string[]): [string, string][] {
  const text = [def.name, ...Object.values(def.names ?? {}), def.category].join(" ").toLowerCase();
  if (MULTI_POTENTIAL.test(text)) return [];
  if (connected.length <= 1) return [];
  if (connected.length === 2) return [[connected[0], connected[1]]];
  const out: [string, string][] = [];
  const k = connected.map((id) => ({ id, key: pinKeyOf(def, id) }));
  for (let i = 0; i < k.length; i++)
    for (let j = i + 1; j < k.length; j++) {
      const a = k[i].key, b = k[j].key;
      const na = Number(a), nb = Number(b);
      if (/^\d{2}$/.test(a) && /^\d{2}$/.test(b) && a[0] === b[0]) out.push([k[i].id, k[j].id]); // 13-14, 21-22, 11-12-14
      else if (/^\d$/.test(a) && /^\d$/.test(b) && Math.min(na, nb) % 2 === 1 && Math.abs(na - nb) === 1) out.push([k[i].id, k[j].id]); // 1-2, 3-4, 5-6
      else if (/^[A-Z]1$/.test(a) && b === a[0] + "2") out.push([k[i].id, k[j].id]); // A1-A2, X1-X2
      else if (/^[A-Z]2$/.test(a) && b === a[0] + "1") out.push([k[i].id, k[j].id]);
    }
  return out;
}

function classForPotential(p: Potential, cfg: WireNumbering): string | null {
  if (p.kind === "PE" || p.kind === "PEN") return "__pe";
  if (p.kind === "DC0") return null; // a return: its class comes from what it returns
  const ac = ["L1", "L2", "L3", "L", "N"].includes(p.kind);
  if (ac) {
    const c = p.volts !== undefined ? cfg.classes.find((x) => x.kind === "ac" && x.volts !== undefined && Math.abs(x.volts - p.volts!) < 1) : undefined;
    return c?.id ?? cfg.defaultAc ?? cfg.classes.find((x) => x.kind === "ac")?.id ?? null;
  }
  if (p.volts !== undefined) {
    const v = Math.abs(p.volts);
    const c = cfg.classes.find((x) => x.kind === "dc" && x.volts !== undefined && Math.abs(x.volts - v) <= Math.max(0.15, x.volts * 0.05));
    if (c) return c.id;
  }
  return cfg.defaultDc ?? cfg.classes.find((x) => x.kind === "dc")?.id ?? null;
}

function classForFunction(fn: WireFunction | undefined, cfg: WireNumbering): string | null {
  switch (fn) {
    case "PE":
      return "__pe";
    case "L1":
    case "L2":
    case "L3":
    case "N":
    case "power":
    case "acControl":
      return cfg.defaultAc ?? cfg.classes.find((x) => x.kind === "ac")?.id ?? null;
    case "dcControl":
      return cfg.defaultDc ?? null;
    case "signal":
      return cfg.classes.find((x) => x.kind === "signal")?.id ?? null;
    default:
      return null;
  }
}

function classByMatch(text: string, cfg: WireNumbering): string | null {
  for (const c of cfg.classes) {
    if (!c.match) continue;
    try {
      if (new RegExp(`(^|[^A-Z])(${c.match})([^A-Z]|$)`, "i").test(text)) return c.id;
    } catch {}
  }
  return null;
}

export function classifyNets(doc: Doc, cfg: WireNumbering = wireNumberingOf(doc), pre?: { idx: ElIndex; nets: ProjectNet[]; netOfPin: Map<string, ProjectNet> }): Map<string, NetClass> {
  const idx = pre?.idx ?? indexElements(doc);
  const { nets, netOfPin } = pre ?? projectNets(doc, idx);
  const wires = new Map<string, Wire>();
  for (const p of doc.pages) for (const w of p.wires) wires.set(w.id, w);
  const byId = new Map(cfg.classes.map((c) => [c.id, c]));
  const letterToId = new Map(cfg.classes.map((c) => [c.letter, c.id]));
  type Seed = { id: string; prio: number; source: string };
  const seeds = new Map<ProjectNet, Seed[]>();
  const ret = new Set<ProjectNet>();
  const add = (n: ProjectNet, id: string | null, prio: number, source: string) => {
    if (!id) return;
    seeds.set(n, [...(seeds.get(n) ?? []), { id, prio, source }]);
  };
  for (const n of nets) {
    for (const { id } of n.wires) {
      const w = wires.get(id);
      if (!w) continue;
      if (w.vclass && (byId.has(w.vclass) || w.vclass === "__pe")) add(n, w.vclass, 0, "set on the wire");
      const lp = potentialOfLabel(w.label);
      if (lp) add(n, classForPotential(lp, cfg), 1, `rail ${w.label}`);
      if (lp?.kind === "DC0" || lp?.kind === "N" || w.fn === "dc0V" || w.fn === "N") ret.add(n);
      add(n, classForFunction(w.fn, cfg), 2, `function ${w.fn}`);
      const parsed = parseWireLabel(w.label, cfg);
      if (parsed?.cls) {
        add(n, parsed.cls === cfg.peLetter ? "__pe" : letterToId.get(parsed.cls) ?? null, 3, `number ${w.label}`);
        if (parsed.ret) ret.add(n);
      }
      if (w.label && !lp && !parsed) add(n, classByMatch(w.label, cfg), 3, `name ${w.label}`);
    }
    for (const p of n.pins) {
      const x = idx.get(p.el);
      const pd = x?.def?.pins.find((q) => q.id === p.pin);
      if (!pd) continue;
      // "+" / "-" outputs of a supply whose rating says the voltage ("24 V DC")
      const sign = (pd.name || pd.number || "").trim().toUpperCase();
      if (/^(\+|V\+|L\+|\+V|OUT\+|\+OUT)$/.test(sign) || /^(-|V-|L-|-V|OUT-|-OUT|0V|GND|M)$/.test(sign)) {
        const t = [x!.e.info.rating, x!.e.info.description, x!.e.info.designation, x!.def!.name].filter(Boolean).join(" ");
        const v = /(\d+(?:[.,]\d+)?)\s*V\s*(?:DC|=|⎓)?/i.exec(t);
        if (v) {
          add(n, classForPotential({ kind: "DC+", volts: Number(v[1].replace(",", ".")), text: `${v[1]} V` }, cfg), 4, `supply ${x!.e.info.label || x!.def!.name} ${v[1]} V`);
          if (!sign.includes("+")) ret.add(n);
        }
      }
      for (const nm of [pd.name, pd.number]) {
        if (!nm) continue;
        const pp = potentialOfLabel(nm);
        if (pp) {
          add(n, classForPotential(pp, cfg), 4, `pin ${x!.e.info.label || x!.def!.name}:${nm}`);
          if (pp.kind === "DC0") ret.add(n);
        } else add(n, classByMatch(nm, cfg), 4, `pin ${x!.e.info.label || x!.def!.name}:${nm}`);
      }
    }
  }
  // graph of circuits joined through two-terminal devices
  const adj = new Map<ProjectNet, Set<ProjectNet>>();
  for (const [id, { def }] of idx) {
    if (!def || isTerminal(def)) continue;
    const connected = def.pins.filter((p) => netOfPin.has(`${id}/${p.id}`)).map((p) => p.id);
    for (const [a, b] of passPairs(def, connected)) {
      const na = netOfPin.get(`${id}/${a}`)!, nb = netOfPin.get(`${id}/${b}`)!;
      if (na === nb) continue;
      if (!adj.has(na)) adj.set(na, new Set());
      if (!adj.has(nb)) adj.set(nb, new Set());
      adj.get(na)!.add(nb);
      adj.get(nb)!.add(na);
    }
  }
  const res = new Map<ProjectNet, NetClass>();
  const out = res;
  const queue: ProjectNet[] = [];
  for (const n of nets) {
    const s = (seeds.get(n) ?? []).sort((a, b) => a.prio - b.prio);
    if (!s.length) continue;
    const best = s[0];
    const others = [...new Set(s.filter((x) => x.id !== best.id && x.prio <= 2).map((x) => x.id))];
    out.set(n, mk(best.id, ret.has(n), best.source, others.length ? `also looks like ${others.map((o) => (o === "__pe" ? "PE" : byId.get(o)?.name ?? o)).join(", ")}` : undefined));
    queue.push(n);
  }
  // breadth first: the nearest classified circuit wins (PE never propagates)
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    const c = out.get(n)!;
    if (c.isPe || !c.classId) continue;
    for (const m of adj.get(n) ?? []) {
      if (out.has(m)) continue;
      out.set(m, mk(c.classId, ret.has(m), `through a device from ${c.letter}`));
      queue.push(m);
    }
  }
  for (const n of nets) if (!out.has(n)) out.set(n, mk(null, ret.has(n), "not determined"));
  return new Map([...res].map(([n, c]) => [n.id, c]));

  function mk(id: string | null, isReturn: boolean, source: string, conflict?: string): NetClass {
    if (id === "__pe") return { classId: "__pe", letter: cfg.peLetter, isReturn: false, isPe: true, source, conflict };
    const c = id ? byId.get(id) : undefined;
    return { classId: c?.id ?? null, letter: c?.letter ?? cfg.fallbackLetter, isReturn, isPe: false, source, conflict };
  }
}

/* ------------------------------------------------------------------ */
/* Plan                                                                 */
/* ------------------------------------------------------------------ */

export type WireLabelChange = { wireId: string; pageId: string; from: string; to: string; cls: string; circuit: string; why: "new" | "renumber" | "class" | "segment" | "merge" | "kept" };
export type WireNumberPlan = {
  changes: WireLabelChange[];
  circuits: { key: string; letter: string; className: string; label: string; wires: number; source: string; conflict?: string; isReturn: boolean }[];
  /** extra conductor data to keep the potential when a rail name is replaced */
  keep: { wireId: string; pageId: string; fn?: WireFunction; vclass?: string }[];
  stats: { circuits: number; wires: number; changed: number; locked: number; unclassified: number };
};

const sizeToken = (doc: Doc, w: Wire) => {
  const mm = sectionMm2(wireInfo(doc, w).section);
  if (mm === null) return "";
  if (wiringOf(doc).standard === "nfpa") {
    const a = AWG_SIZES.reduce((b, x) => (Math.abs(x.mm2 - mm) < Math.abs(b.mm2 - mm) ? x : b));
    return a.awg.replace("/", "");
  }
  return String(mm);
};

export function planWireNumbers(doc: Doc, opts: { mode: "new" | "all"; pageIds?: string[] } = { mode: "new" }, cfg: WireNumbering = wireNumberingOf(doc)): WireNumberPlan {
  const idx = indexElements(doc);
  const pn = projectNets(doc, idx);
  const cls = classifyNets(doc, cfg, { idx, ...pn });
  const pages = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const pageNo = new Map(pages.map((p, i) => [p.id, i + 1]));
  const wireAt = new Map<string, { w: Wire; page: Page }>();
  for (const page of pages) for (const w of page.wires) wireAt.set(w.id, { w, page });
  const scope = opts.pageIds ? new Set(opts.pageIds) : null;
  const byId = new Map(cfg.classes.map((c) => [c.id, c]));

  const pos = (wid: string) => {
    const x = wireAt.get(wid)!;
    const p = x.w.pts.reduce((a, b) => (b.x < a.x || (b.x === a.x && b.y < a.y) ? b : a), x.w.pts[0] ?? { x: 0, y: 0 });
    const b = x.page.border;
    const hx = b.showRows ? b.headerW : 0, hy = b.showCols ? b.headerH : 0;
    return { page: pageNo.get(x.page.id) ?? 0, col: Math.max(1, Math.floor((p.x - hx) / b.colW) + 1), row: String.fromCharCode(65 + (Math.max(0, Math.floor((p.y - hy) / b.rowH)) % 26)), x: p.x, y: p.y };
  };
  const cmp = (a: string, b: string) => {
    const pa = pos(a), pb = pos(b);
    return pa.page - pb.page || pa.col - pb.col || pa.y - pb.y || pa.x - pb.x;
  };

  // circuits in reading order: sheet, column, top to bottom
  const nets = pn.nets.filter((n) => n.wires.length).map((n) => ({ n, wires: n.wires.map((w) => w.id).sort(cmp) }));
  nets.sort((a, b) => cmp(a.wires[0], b.wires[0]));

  const changes: WireLabelChange[] = [];
  const keep: WireNumberPlan["keep"] = [];
  const circuits: WireNumberPlan["circuits"] = [];
  let locked = 0;

  // numbers already taken per class (locked always; existing ones in "new" mode)
  const used = new Map<string, Set<number>>();
  const take = (letter: string, n: number) => {
    if (!used.has(letter)) used.set(letter, new Set());
    used.get(letter)!.add(n);
  };
  const isLockedOrForeign = (w: Wire) => w.labelLocked || (!!w.label && !!potentialOfLabel(w.label) && !cfg.replacePotentialNames);
  for (const { wires } of nets)
    for (const wid of wires) {
      const w = wireAt.get(wid)!.w;
      const p = parseWireLabel(w.label, cfg);
      if (p?.n !== undefined && (w.labelLocked || opts.mode === "new")) take(p.cls, p.n);
    }
  const next = (letter: string) => {
    const s = used.get(letter) ?? new Set<number>();
    let n = cfg.start;
    if (opts.mode === "new") n = Math.max(cfg.start, ...[...s].map((x) => x + 1));
    while (s.has(n)) n++;
    take(letter, n);
    return n;
  };
  const hasN = /\{n(?::\d+)?\}/.test(cfg.format);
  const placeUsed = new Map<string, number>();

  for (const { n, wires } of nets) {
    const c = cls.get(n.id)!;
    const inScope = !scope || wires.some((wid) => scope.has(wireAt.get(wid)!.page.id));
    const letter = c.letter;
    const cname = c.isPe ? "Protective earth" : c.classId ? byId.get(c.classId)?.name ?? letter : "Unclassified";
    // keep this circuit's number when its wires already carry one (the most used, if several)
    const counts = new Map<number, number>();
    const segs = new Map<string, string>();
    for (const wid of wires) {
      const w = wireAt.get(wid)!.w;
      const p = parseWireLabel(w.label, cfg);
      if (p && p.cls === letter && p.n !== undefined) counts.set(p.n, (counts.get(p.n) ?? 0) + 1);
      if (p?.seg) segs.set(wid, p.seg);
    }
    let num: number | undefined;
    if (hasN) {
      if (opts.mode === "new" && counts.size) {
        num = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
        // a merge: another circuit already kept this number → new number
        const key = `${letter}#${num}`;
        if (placeUsed.has(key)) num = undefined;
      }
      if (num === undefined) {
        const lockedHere = wires.map((wid) => parseWireLabel(wireAt.get(wid)!.w.label, cfg)).find((p, i) => p?.n !== undefined && wireAt.get(wires[i])!.w.labelLocked && p.cls === letter);
        num = lockedHere?.n ?? next(letter);
      }
      placeUsed.set(`${letter}#${num}`, 1);
    }
    const first = pos(wires[0]);
    let dup: number | undefined;
    if (!hasN) {
      const key = `${letter}|${first.page}|${first.col}|${first.row}`;
      const k = (placeUsed.get(key) ?? 0) + 1;
      placeUsed.set(key, k);
      if (k > 1) dup = k;
    }
    const base: LabelParts = { cls: letter, n: num, seg: "", ret: c.isReturn && !c.isPe, page: first.page, col: first.col, row: first.row };
    const circuitLabel = formatWireLabel({ ...cfg, segments: false }, base) + (dup ? `.${dup}` : "");
    circuits.push({ key: `${letter}${num ?? `${first.page}.${first.col}`}${dup ? `.${dup}` : ""}`, letter, className: cname, label: circuitLabel, wires: wires.length, source: c.source, conflict: c.conflict, isReturn: base.ret });
    // segment letters: keep valid existing ones, give new segments the next free letter
    const taken = new Set<number>();
    const segOf = new Map<string, number>();
    if (cfg.segments && opts.mode === "new")
      for (const wid of wires) {
        const s = segs.get(wid);
        const p = parseWireLabel(wireAt.get(wid)!.w.label, cfg);
        if (s && p?.n === num && p?.cls === letter && !taken.has(segIndex(s))) {
          taken.add(segIndex(s));
          segOf.set(wid, segIndex(s));
        }
      }
    let si = 0;
    for (const wid of wires) {
      const { w, page } = wireAt.get(wid)!;
      if (w.labelLocked) {
        locked++;
        continue;
      }
      if (!inScope || (scope && !scope.has(page.id))) continue;
      if (w.label && potentialOfLabel(w.label) && !cfg.replacePotentialNames) continue;
      let seg = "";
      if (cfg.segments) {
        let k = segOf.get(wid);
        if (k === undefined) {
          while (taken.has(si)) si++;
          k = si;
          taken.add(k);
        }
        seg = segLetter(k);
      }
      const to = formatWireLabel(cfg, { ...base, seg, size: sizeToken(doc, w) }) + (dup ? `.${dup}` : "");
      const from = w.label ?? "";
      if (from === to) continue;
      const p = parseWireLabel(from, cfg);
      const why: WireLabelChange["why"] = !from ? "new" : p && p.cls !== letter ? "class" : p && p.n !== num ? (counts.size > 1 ? "merge" : "renumber") : p ? "segment" : "renumber";
      changes.push({ wireId: wid, pageId: page.id, from, to, cls: letter, circuit: circuitLabel, why });
      // a rail name being replaced: keep its meaning as conductor function / class
      const lp = potentialOfLabel(from);
      if (lp) {
        const fn: WireFunction | undefined = w.fn ?? (lp.kind === "DC0" ? "dc0V" : lp.kind === "PE" ? "PE" : lp.kind === "N" ? "N" : ["L1", "L2", "L3"].includes(lp.kind) ? (lp.kind as WireFunction) : lp.kind === "DC+" ? "dcControl" : undefined);
        keep.push({ wireId: wid, pageId: page.id, fn, vclass: w.vclass ?? (c.classId ?? undefined) });
      }
    }
  }
  void isLockedOrForeign;
  const allWires = nets.reduce((a, x) => a + x.wires.length, 0);
  return {
    changes,
    circuits,
    keep,
    stats: { circuits: nets.length, wires: allWires, changed: changes.length, locked, unclassified: [...cls.values()].filter((c) => !c.classId && !c.isPe).length },
  };
}

/** apply a plan (inside an undoable editor transaction or on a server copy) */
export function applyWireNumbers(doc: Doc, plan: Pick<WireNumberPlan, "changes" | "keep">) {
  const at = new Map<string, Wire>();
  for (const p of doc.pages) for (const w of p.wires) at.set(w.id, w);
  for (const k of plan.keep) {
    const w = at.get(k.wireId);
    if (!w) continue;
    if (k.fn && !w.fn) w.fn = k.fn;
    if (k.vclass && !w.vclass) w.vclass = k.vclass;
  }
  for (const c of plan.changes) {
    const w = at.get(c.wireId);
    if (w) w.label = c.to;
  }
}

/** the circuit class a wire was detected as (for the conductor panel) */
export function wireClassOf(doc: Doc, wireId: string, cfg: WireNumbering = wireNumberingOf(doc)): NetClass | null {
  const idx = indexElements(doc);
  const pn = projectNets(doc, idx);
  const n = pn.netOfWire.get(wireId);
  if (!n) return null;
  return classifyNets(doc, cfg, { idx, ...pn }).get(n.id) ?? null;
}
