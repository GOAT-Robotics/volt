/**
 * Terminal strips: every terminal drawn in the project, grouped into strips by reference
 * ("X1:3" → strip X1, terminal 3), with what each side connects to, and the strip data kept on
 * the document (order, type, level, bridges, spares, part numbers).
 *
 * The reference IS the terminal designation: renumbering writes "X1:3" into the label of every
 * instance of that terminal, so drawings, cross-references, the BOM and .qet export follow.
 * Instances sharing a full reference are the same terminal (e.g. shown on two sheets).
 * A terminal labelled only "X1" (no number yet) is its own, unnumbered row of strip X1.
 */
import type { Doc, ElemInst, ElementDef, Page, StripRow, TerminalStrip, TerminalType, Wire } from "./model";
import { rotOrient } from "./geometry";
import { wireInfo } from "./wiring";
import { uid } from "./ids";

export const TERMINAL_TYPES: { id: TerminalType; label: string; short: string }[] = [
  { id: "feed", label: "Feed-through", short: "" },
  { id: "pe", label: "Protective earth (PE)", short: "PE" },
  { id: "neutral", label: "Neutral (N)", short: "N" },
  { id: "fuse", label: "Fuse", short: "F" },
  { id: "disconnect", label: "Disconnect / test", short: "T" },
  { id: "diode", label: "Diode / LED", short: "D" },
  { id: "sensor", label: "Sensor / actuator", short: "S" },
  { id: "multi", label: "Multi-level", short: "ML" },
];
export const terminalTypeLabel = (t: TerminalType | undefined) => TERMINAL_TYPES.find((x) => x.id === (t ?? "feed"))!.label;

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Terminal symbols: QET "terminal" link type, or named / filed as a terminal (not splices or multi-pole blocks). */
export function isTerminalDef(def: ElementDef | undefined): boolean {
  if (!def || !def.pins.length || def.name === "volt_junction") return false;
  const s = [def.name, ...Object.values(def.names), def.category, def.source?.path ?? ""].join(" ").toLowerCase();
  if (/splice|épissure|epissure|spleiß|empalme|wire connector|junction/.test(s)) return false;
  if (def.linkType === "terminal") return true;
  return def.pins.length <= 4 && /\bterminal\b(?! strip label)|\bborne\b|reihenklemme|klemme/.test(s) && !/connector|plug|socket|3p\+n|busbar|bar\b/.test(s);
}

/** Default type from the symbol (QET kindInformation "function" / "type", or its name). */
export function defTerminalType(def: ElementDef): TerminalType {
  const f = (def.kind.function ?? "").toLowerCase(), t = (def.kind.type ?? "").toLowerCase();
  const s = [def.name, ...Object.values(def.names)].join(" ").toLowerCase();
  if (f === "pe" || /\bpe\b|ground|earth|terre/.test(s)) return "pe";
  if (f === "neutral" || /neutral|neutre/.test(s)) return "neutral";
  if (t === "fuse" || /fus/.test(s)) return "fuse";
  if (t === "sectional" || /disconnect|sectionn|test/.test(s)) return "disconnect";
  if (t === "diode" || /diode|led/.test(s)) return "diode";
  if (/double|multi|level|étage/.test(s)) return "multi";
  return "feed";
}

/** "X1:3" / "-X1:3" / "X1-03" / "X1.3" → strip + number; "X1" → strip only. */
export function parseTerminalRef(label: string): { tag: string; num: string | null; sep: string } {
  const s = label.trim();
  // a bare number ("12", "3a"): a numbered terminal that is not in any strip yet
  if (/^\d+[A-Za-z]?$/.test(s)) return { tag: "", num: s, sep: ":" };
  const m = /^(.*?[A-Za-z][^:.\-]*?)([:.\-])([A-Za-z]*\d[\w]*|PE\d*|N\d*)$/.exec(s);
  if (m) return { tag: m[1], num: m[3], sep: m[2] };
  return { tag: s, num: null, sep: ":" };
}

export type TerminalInstance = { el: string; pageId: string; sheet: number };
export type TerminalRowView = {
  /** stable key: the number, or "@<element id>" for an unnumbered terminal, or "spare:<num>" */
  key: string;
  num: string | null;
  instances: TerminalInstance[];
  row: StripRow | null;
  type: TerminalType;
  spare: boolean;
  symbol: string;
  /** what each side connects to: side 1 = top / left pins, side 2 = bottom / right pins */
  side1: string[];
  side2: string[];
  /** the same, structured (for the terminal diagram sheet) */
  conn1: TerminalConn[];
  conn2: TerminalConn[];
};
/** one conductor at a terminal side: where it goes, its wire number, cable / core and colour */
export type TerminalConn = { to: string[]; wire: string; cable: string; color?: string; hex?: string; section?: string };
export type StripView = { tag: string; strip: TerminalStrip | null; sep: string; rows: TerminalRowView[] };

type Found = { e: ElemInst; def: ElementDef; page: Page; sheet: number; tag: string; num: string | null; sep: string };

function findTerminals(doc: Doc): Found[] {
  const pages = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const out: Found[] = [];
  pages.forEach((page, i) => {
    for (const e of page.elements) {
      const def = doc.defs[e.defId];
      if (!isTerminalDef(def) || e.hidden) continue;
      const ref = parseTerminalRef(e.info.label ?? "");
      out.push({ e, def: def!, page, sheet: i + 1, tag: ref.tag, num: ref.num, sep: ref.sep });
    }
  });
  return out;
}


type WireIndex = { byPin: Map<string, Wire[]>; byJunction: Map<string, Wire[]> };
const wireIndexCache = new WeakMap<Page["wires"], WireIndex>();
function wireIndex(page: Page): WireIndex {
  let ix = wireIndexCache.get(page.wires);
  if (ix) return ix;
  ix = { byPin: new Map(), byJunction: new Map() };
  const add = (m: Map<string, Wire[]>, k: string, w: Wire) => m.set(k, [...(m.get(k) ?? []), w]);
  for (const w of page.wires)
    for (const end of [w.a, w.b]) {
      if (end.k === "pin") add(ix.byPin, `${end.el}/${end.pin}`, w);
      else if (end.k === "junction") add(ix.byJunction, end.j, w);
    }
  wireIndexCache.set(page.wires, ix);
  return ix;
}

/**
 * Follow one conductor that leaves a terminal pin: through junctions and further wires, up to the
 * device pins it reaches (not back into the terminal). Returns those pins and the wires passed.
 */
function followConductor(page: Page, start: Wire, from: { el: string; pin: string }): { pins: { el: string; pin: string }[]; wires: Wire[] } {
  const ix = wireIndex(page);
  const seenW = new Set<string>([start.id]);
  const seenJ = new Set<string>();
  const pins: { el: string; pin: string }[] = [];
  const wires: Wire[] = [start];
  const queue: Wire[] = [start];
  while (queue.length) {
    const w = queue.shift()!;
    for (const end of [w.a, w.b]) {
      if (end.k === "pin") {
        if (end.el === from.el && end.pin === from.pin) continue;
        if (!pins.some((p) => p.el === end.el && p.pin === end.pin)) pins.push({ el: end.el, pin: end.pin });
      } else if (end.k === "junction" && !seenJ.has(end.j)) {
        seenJ.add(end.j);
        for (const n of ix.byJunction.get(end.j) ?? []) if (!seenW.has(n.id)) (seenW.add(n.id), wires.push(n), queue.push(n));
      }
    }
  }
  return { pins, wires };
}

/** which side a wire leaves a terminal pin to: 1 = up / left, 2 = down / right (falls back to the pin direction) */
function sideOfWire(w: Wire, el: string, pin: string, fallback: 1 | 2): 1 | 2 {
  const atA = w.a.k === "pin" && w.a.el === el && w.a.pin === pin;
  const pts = atA ? w.pts : [...w.pts].reverse();
  const p0 = pts[0];
  const p1 = pts.find((q) => Math.abs(q.x - p0.x) + Math.abs(q.y - p0.y) > 0.5);
  if (!p1) return fallback;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 1 : 2;
  return dx < 0 ? 1 : 2;
}

/**
 * Destinations of one terminal instance, per side: "Q1:2 (W1 · 101)". Every conductor on the
 * terminal counts on the side it leaves from — a one-pin terminal drawn in a line with the wire
 * coming from above and going on below has a top AND a bottom connection.
 */
function connections(doc: Doc, f: Found): { side1: string[]; side2: string[]; conn1: TerminalConn[]; conn2: TerminalConn[] } {
  const side1: string[] = [], side2: string[] = [];
  const conn1: TerminalConn[] = [], conn2: TerminalConn[] = [];
  const els = new Map(f.page.elements.map((x) => [x.id, x]));
  const ix = wireIndex(f.page);
  const name = (p: { el: string; pin: string }) => {
    const x = els.get(p.el);
    const d = x && doc.defs[x.defId];
    const pd = d?.pins.find((q) => q.id === p.pin);
    const ref = x?.info.label || d?.names.en || d?.name || "?";
    const pn = pd?.number || pd?.name;
    return pn ? `${ref}:${pn}` : ref;
  };
  for (const pin of f.def.pins) {
    const o = rotOrient(pin.orient, f.e.rot, f.e.mirror);
    const pinSide: 1 | 2 = o === "n" || o === "w" ? 1 : 2;
    for (const wire of ix.byPin.get(`${f.e.id}/${pin.id}`) ?? []) {
      const side = f.def.pins.length === 1 ? sideOfWire(wire, f.e.id, pin.id, pinSide) : pinSide;
      const into = side === 1 ? side1 : side2;
      const cinto = side === 1 ? conn1 : conn2;
      const reach = followConductor(f.page, wire, { el: f.e.id, pin: pin.id });
      const targets = [...new Set(reach.pins.filter((p) => p.el !== f.e.id).map(name))];
      const label = wire.label?.trim() || reach.wires.find((w) => w.label?.trim())?.label?.trim() || "";
      const wi = wireInfo(doc, wire);
      const conn: TerminalConn = { to: targets, wire: label, cable: wire.cable ? `${wire.cable}${wire.core ? `:${wire.core}` : ""}` : "", color: wi.color, hex: wi.look?.hex, section: wi.section };
      const parts = [wire.cable ? `${wire.cable}${wire.core ? ` ${wire.core}` : ""}` : "", label, !wire.cable && wi.section ? wi.section : ""].filter(Boolean);
      const text = (targets.length ? targets.join(", ") : "—") + (parts.length ? ` (${parts.join(" · ")})` : "");
      if (!into.includes(text)) into.push(text);
      if (!cinto.some((c) => c.wire === conn.wire && c.to.join() === conn.to.join())) cinto.push(conn);
    }
  }
  return { side1, side2, conn1, conn2 };
}

export function stripOf(doc: Doc, tag: string): TerminalStrip | null {
  return (doc.terminalStrips ?? []).find((s) => s.tag === tag) ?? null;
}

/** All strips of the project (defined ones and those found on the drawings), terminals in strip order. */
export function collectStrips(doc: Doc): StripView[] {
  const found = findTerminals(doc);
  const tags = new Set<string>([...(doc.terminalStrips ?? []).map((s) => s.tag), ...found.map((f) => f.tag)]);
  const views: StripView[] = [];
  for (const tag of tags) {
    const strip = stripOf(doc, tag);
    const mine = found.filter((f) => f.tag === tag);
    const sep = strip?.sep ?? mine.find((f) => f.num)?.sep ?? ":";
    const byKey = new Map<string, TerminalRowView>();
    for (const f of mine) {
      // without a strip, equal bare numbers are different terminals
      const key = tag && f.num ? f.num : `@${f.e.id}`;
      let r = byKey.get(key);
      if (!r) {
        r = { key, num: f.num, instances: [], row: null, type: defTerminalType(f.def), spare: false, symbol: f.def.names.en ?? f.def.name, side1: [], side2: [], conn1: [], conn2: [] };
        byKey.set(key, r);
      }
      r.instances.push({ el: f.e.id, pageId: f.page.id, sheet: f.sheet });
      const c = connections(doc, f);
      for (const t of c.side1) if (!r.side1.includes(t)) r.side1.push(t);
      for (const t of c.side2) if (!r.side2.includes(t)) r.side2.push(t);
      for (const t of c.conn1) if (!r.conn1.some((x) => x.wire === t.wire && x.to.join() === t.to.join())) r.conn1.push(t);
      for (const t of c.conn2) if (!r.conn2.some((x) => x.wire === t.wire && x.to.join() === t.to.join())) r.conn2.push(t);
    }
    const rows: TerminalRowView[] = [];
    // stored order first
    for (const sr of strip?.rows ?? []) {
      const v = byKey.get(sr.num);
      if (v) {
        v.row = sr;
        if (sr.type) v.type = sr.type;
        rows.push(v);
        byKey.delete(sr.num);
      } else if (sr.spare) {
        rows.push({ key: `spare:${sr.num}`, num: sr.num, instances: [], row: sr, type: sr.type ?? "feed", spare: true, symbol: "", side1: [], side2: [], conn1: [], conn2: [] });
      }
    }
    // new numbered terminals (natural order), then unnumbered ones in drawing order
    const rest = [...byKey.values()];
    rows.push(...rest.filter((r) => r.num).sort((a, b) => natural.compare(a.num!, b.num!)));
    rows.push(...rest.filter((r) => !r.num).sort((a, b) => a.instances[0].sheet - b.instances[0].sheet));
    views.push({ tag, strip, sep, rows });
  }
  return views.sort((a, b) => natural.compare(a.tag, b.tag));
}

/* ------------------------------------------------------------------ */
/* Edits (run inside an undoable apply)                                 */
/* ------------------------------------------------------------------ */

/** The strip record, created from what is drawn when it does not exist yet (keeps the shown order). */
export function ensureStrip(doc: Doc, tag: string): TerminalStrip {
  if (!tag) throw new Error("Give the terminals a strip first");
  let s = stripOf(doc, tag);
  if (s) return s;
  const view = collectStrips(doc).find((v) => v.tag === tag);
  s = { id: uid(), tag, sep: view?.sep ?? ":", rows: (view?.rows ?? []).filter((r) => r.num).map((r) => ({ num: r.num! })) };
  doc.terminalStrips = [...(doc.terminalStrips ?? []), s];
  return s;
}

function elementsById(doc: Doc) {
  const m = new Map<string, ElemInst>();
  for (const p of doc.pages) for (const e of p.elements) m.set(e.id, e);
  return m;
}

/** Instances of a row (by key) in the current drawing. */
function instancesOf(doc: Doc, tag: string, key: string): ElemInst[] {
  const els = elementsById(doc);
  if (key.startsWith("@")) {
    const e = els.get(key.slice(1));
    return e ? [e] : [];
  }
  const out: ElemInst[] = [];
  for (const e of els.values()) {
    if (!isTerminalDef(doc.defs[e.defId])) continue;
    const r = parseTerminalRef(e.info.label ?? "");
    if (r.tag === tag && r.num === key) out.push(e);
  }
  return out;
}

const refOf = (s: TerminalStrip, num: string) => `${s.tag}${s.sep}${num}`;

/** Give a terminal (row key) a new number; every instance's reference follows. */
export function setTerminalNumber(doc: Doc, tag: string, key: string, num: string) {
  const s = ensureStrip(doc, tag);
  num = num.trim();
  if (!num) return;
  const els = instancesOf(doc, tag, key);
  for (const e of els) {
    e.info.label = refOf(s, num);
    e.refLocked = true;
  }
  const oldNum = key.startsWith("@") ? null : key.replace(/^spare:/, "");
  const row = oldNum ? s.rows.find((r) => r.num === oldNum) : null;
  if (row) row.num = num;
  else if (!s.rows.some((r) => r.num === num)) s.rows.push({ num });
}

/** Store the order shown (keys top to bottom); unnumbered terminals keep their place once numbered. */
export function setOrder(doc: Doc, tag: string, keys: string[]) {
  const s = ensureStrip(doc, tag);
  const byNum = new Map(s.rows.map((r) => [r.num, r]));
  const rows: StripRow[] = [];
  for (const k of keys) {
    const num = k.startsWith("@") ? null : k.replace(/^spare:/, "");
    if (num) rows.push(byNum.get(num) ?? { num });
  }
  s.rows = rows;
}

/** Number every terminal of the strip in the shown order: start, step, zero padding. */
export function renumberStrip(doc: Doc, tag: string, keys: string[], o: { start?: number; step?: number; pad?: number; prefix?: string } = {}) {
  const s = ensureStrip(doc, tag);
  const start = o.start ?? 1, step = o.step ?? 1, pad = o.pad ?? 0, prefix = o.prefix ?? "";
  const plan = keys.map((k, i) => ({ k, num: prefix + String(start + i * step).padStart(pad, "0"), els: instancesOf(doc, tag, k) }));
  const oldRows = new Map(s.rows.map((r) => [r.num, r]));
  s.rows = plan.map(({ k, num }) => {
    const old = k.startsWith("@") ? undefined : oldRows.get(k.replace(/^spare:/, ""));
    return { ...(old ?? {}), num };
  });
  for (const p of plan)
    for (const e of p.els) {
      e.info.label = refOf(s, p.num);
      e.refLocked = true;
    }
}

export function setRow(doc: Doc, tag: string, num: string, patch: Partial<StripRow>) {
  const s = ensureStrip(doc, tag);
  let r = s.rows.find((x) => x.num === num);
  if (!r) s.rows.push((r = { num }));
  Object.assign(r, patch);
  for (const k of Object.keys(patch) as (keyof StripRow)[]) if (patch[k] === undefined || patch[k] === "" || patch[k] === false) delete r[k];
}

export function setStrip(doc: Doc, tag: string, patch: Partial<Omit<TerminalStrip, "id" | "rows">>) {
  const s = ensureStrip(doc, tag);
  const oldTag = s.tag, oldSep = s.sep;
  const nextTag = patch.tag?.trim() || oldTag, nextSep = patch.sep ?? oldSep;
  if (nextTag !== oldTag || nextSep !== oldSep) {
    if (nextTag !== oldTag && stripOf(doc, nextTag)) throw new Error(`Strip ${nextTag} already exists`);
    // references follow the strip name and separator
    for (const e of elementsById(doc).values()) {
      if (!isTerminalDef(doc.defs[e.defId])) continue;
      const r = parseTerminalRef(e.info.label ?? "");
      if (r.tag !== oldTag) continue;
      e.info.label = r.num ? `${nextTag}${nextSep}${r.num}` : nextTag;
      e.refLocked = true;
    }
  }
  Object.assign(s, { ...patch, tag: nextTag, sep: nextSep });
  for (const k of ["description", "location", "partNumber", "manufacturer"] as const) if (!s[k]) delete s[k];
}

/** Next free number after the highest numeric one. */
export function nextTerminalNumber(doc: Doc, tag: string): string {
  const v = collectStrips(doc).find((x) => x.tag === tag);
  let max = 0;
  for (const r of v?.rows ?? []) {
    const n = Number(r.num);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return String(max + 1);
}

/** Add a spare terminal (on the rail, not drawn) after the given row, or at the end. */
export function addSpare(doc: Doc, tag: string, afterKey?: string, keys?: string[]): string {
  const num = nextTerminalNumber(doc, tag);
  const s = ensureStrip(doc, tag);
  if (keys) setOrder(doc, tag, keys);
  const row: StripRow = { num, spare: true };
  const at = afterKey ? s.rows.findIndex((r) => r.num === afterKey.replace(/^spare:/, "")) : -1;
  if (at >= 0) s.rows.splice(at + 1, 0, row);
  else s.rows.push(row);
  return num;
}

export function removeRow(doc: Doc, tag: string, num: string) {
  const s = ensureStrip(doc, tag);
  s.rows = s.rows.filter((r) => r.num !== num);
}

/** Move a terminal to another strip; it gets that strip's next free number. */
export function moveToStrip(doc: Doc, fromTag: string, key: string, toTag: string): string {
  const els = instancesOf(doc, fromTag, key);
  const num = nextTerminalNumber(doc, toTag);
  const to = ensureStrip(doc, toTag);
  const from = fromTag ? ensureStrip(doc, fromTag) : null;
  const oldNum = key.startsWith("@") ? null : key.replace(/^spare:/, "");
  const old = from && oldNum ? from.rows.find((r) => r.num === oldNum) : undefined;
  if (from && oldNum) from.rows = from.rows.filter((r) => r.num !== oldNum);
  to.rows.push({ ...(old ?? {}), num });
  for (const e of els) {
    e.info.label = refOf(to, num);
    e.refLocked = true;
  }
  return num;
}

/**
 * Put terminals into a strip (e.g. everything under "No strip"). Bare numbers are kept when they
 * are free in the target strip; the others get the next free numbers.
 */
export function assignToStrip(doc: Doc, fromTag: string, keys: string[], toTag: string, keepNumbers = true): number {
  const to = ensureStrip(doc, toTag);
  const used = new Set(collectStrips(doc).find((v) => v.tag === toTag)?.rows.map((r) => r.num).filter(Boolean) as string[]);
  let n = 0;
  for (const key of keys) {
    const els = instancesOf(doc, fromTag, key);
    if (!els.length) continue;
    const cur = parseTerminalRef(els[0].info.label ?? "").num;
    let num = keepNumbers && cur && !used.has(cur) ? cur : null;
    if (!num) {
      let k = 1;
      for (const u of used) if (Number.isFinite(Number(u))) k = Math.max(k, Number(u) + 1);
      num = String(k);
    }
    used.add(num);
    if (!to.rows.some((r) => r.num === num)) to.rows.push({ num });
    for (const e of els) {
      e.info.label = refOf(to, num);
      e.refLocked = true;
    }
    n++;
  }
  // keep the strip in number order
  to.rows.sort((a, b) => natural.compare(a.num, b.num));
  return n;
}

/** A new strip with `count` terminals numbered from `start` (rows only — place them on a sheet with placeTerminals). */
export function createStrip(doc: Doc, tag: string, count: number, start = 1) {
  if (stripOf(doc, tag)) throw new Error(`Strip ${tag} already exists`);
  const rows: StripRow[] = Array.from({ length: Math.max(0, Math.min(500, count)) }, (_, i) => ({ num: String(start + i), spare: true }));
  doc.terminalStrips = [...(doc.terminalStrips ?? []), { id: uid(), tag, sep: ":", rows }];
}

/** Volt's own feed-through terminal symbol (used when the project has no terminal symbol yet) */
export function builtinTerminalDef(): ElementDef {
  const st = { lineStyle: "normal", lineWeight: "normal", filling: "none", color: "black" } as const;
  return {
    id: "volt/terminal-feed-through",
    uuid: "{6f1c1f7e-8a7b-4c2e-9d1b-000000000001}",
    name: "Terminal",
    names: { en: "Terminal (feed-through)" },
    width: 10,
    height: 30,
    hotspotX: 5,
    hotspotY: 15,
    linkType: "terminal",
    prefix: "X",
    category: "volt/terminals",
    prims: [
      { t: "rect", x: -4, y: -9, w: 8, h: 18, rx: 0, ry: 0, style: { ...st } },
      { t: "ellipse", x: -2, y: -6, w: 4, h: 4, style: { ...st } },
      { t: "ellipse", x: -2, y: 2, w: 4, h: 4, style: { ...st } },
      { t: "line", x1: 0, y1: -15, x2: 0, y2: -9, end1: "none", end2: "none", len1: 1.5, len2: 1.5, style: { ...st } },
      { t: "line", x1: 0, y1: 9, x2: 0, y2: 15, end1: "none", end2: "none", len1: 1.5, len2: 1.5, style: { ...st } },
    ],
    pins: [
      { id: "1", x: 0, y: -15, orient: "n", name: "", number: "1", type: "Generic" },
      { id: "2", x: 0, y: 15, orient: "s", name: "", number: "2", type: "Generic" },
    ],
    info: {},
    kind: { type: "generic", function: "generic" },
    meta: {},
  };
}

/** terminal symbols available for placing: those used in the strip, in the project, then the built-in one */
export function terminalSymbols(doc: Doc, tag?: string): ElementDef[] {
  const out: ElementDef[] = [];
  const add = (d: ElementDef | undefined) => d && !out.some((x) => x.id === d.id) && out.push(d);
  if (tag) for (const f of findTerminals(doc)) if (f.tag === tag) add(f.def);
  for (const f of findTerminals(doc)) add(f.def);
  for (const d of Object.values(doc.defs)) if (isTerminalDef(d)) add(d);
  add(builtinTerminalDef());
  return out;
}

const LABEL_H = 12;
const termPitch = (def: ElementDef, dir: "h" | "v", g: number) => {
  const snap = (v: number) => Math.ceil(v / g) * g;
  return dir === "h" ? Math.max(20, snap(def.width + LABEL_H + 6)) : Math.max(20, snap(def.height + 10));
};

/** what is drawn on a sheet (symbols, wires, free texts with all their lines, shapes) */
function usedArea(doc: Doc, page: Page): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number, w = 0, h = 0) => ((x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x + w)), (y1 = Math.max(y1, y + h)));
  for (const e of page.elements) {
    const d = doc.defs[e.defId];
    const w = d?.width ?? 20, h = d?.height ?? 20;
    const r = Math.max(w, h);
    add(e.x - r, e.y - r, 2 * r + 40, 2 * r);
  }
  for (const w of page.wires) for (const p of w.pts) add(p.x, p.y);
  for (const t of page.texts) {
    const lines = String((t as { text?: string }).text ?? "").split("\n");
    add(t.x, t.y, Math.max(...lines.map((l) => l.length)) * 8, lines.length * 16);
  }
  for (const sh of page.shapes) for (const p of sh.pts) add(p.x, p.y);
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function frame(page: Page) {
  const b = page.border;
  const hx = b.showRows ? b.headerW : 0, hy = b.showCols ? b.headerH : 0;
  return { hx, hy, W: hx + b.cols * b.colW, H: hy + b.rows * b.rowH, colW: b.colW, rowH: b.rowH };
}

/** a free spot for `n` terminals inside the frame (below what is drawn, else to its right); null = no room */
export function freeSpot(doc: Doc, page: Page, def: ElementDef, n: number, dir: "h" | "v" = "h", pitch?: number): { x: number; y: number } | null {
  const g = doc.grid?.size || 10;
  const snap = (v: number) => Math.round(v / g) * g;
  const p = pitch ?? termPitch(def, dir, g);
  const f = frame(page);
  const len = p * (n - 1);
  const spanW = dir === "h" ? len + def.width + LABEL_H : def.width + 80;
  const spanH = dir === "v" ? len + def.height : def.height + 60;
  const used = usedArea(doc, page);
  const left = f.hx + f.colW / 2, top = f.hy + f.rowH / 2, right = f.W - f.colW / 2, bottom = f.H - f.rowH * 1.5; // keep clear of the title block
  if (!used) {
    if (spanW > right - left || spanH > bottom - top) return null;
    return { x: snap(Math.max(left, (f.W - spanW) / 2)), y: snap(dir === "h" ? f.H / 2 - f.rowH / 2 : top + def.hotspotY) };
  }
  const below = used.y + used.h + 50;
  if (below + spanH <= bottom && left + spanW <= right) return { x: snap(Math.max(left, used.x) + def.hotspotX), y: snap(below + def.hotspotY) };
  const rightOf = used.x + used.w + 50;
  if (rightOf + spanW <= right && top + spanH <= bottom) return { x: snap(rightOf + def.hotspotX), y: snap(top + def.hotspotY) };
  return null;
}

function fallbackSpot(doc: Doc, page: Page) {
  const f = frame(page);
  const used = usedArea(doc, page);
  return { x: f.hx + f.colW, y: (used ? used.y + used.h : f.hy) + 60 };
}

/**
 * Draw terminals of a strip on a sheet, side by side (or one under the other) at `pitch` spacing,
 * starting at `at` or in a free area below what is already drawn. Returns the new element ids.
 */
export function placeTerminals(doc: Doc, page: Page, tag: string, nums: string[], def: ElementDef, o: { dir?: "h" | "v"; pitch?: number; at?: { x: number; y: number }; newElement: (doc: Doc, page: Page, def: ElementDef, at: { x: number; y: number }) => ElemInst }): string[] {
  const s = ensureStrip(doc, tag);
  const g = doc.grid?.size || 10;
  const snap = (v: number) => Math.round(v / g) * g;
  const dir = o.dir ?? "h";
  const pitch = o.pitch ?? termPitch(def, dir, g);
  const at = o.at ?? freeSpot(doc, page, def, nums.length, dir, pitch) ?? fallbackSpot(doc, page);
  const ids: string[] = [];
  nums.forEach((num, i) => {
    const e = o.newElement(doc, page, def, { x: at!.x + (dir === "h" ? i * pitch : 0), y: at!.y + (dir === "v" ? i * pitch : 0) });
    e.info.label = refOf(s, num);
    e.refLocked = true;
    // side by side: the reference reads vertically, right beside its terminal, so neighbours do not overlap
    if (dir === "h") {
      const t = e.texts.find((x) => x.info === "label");
      if (t) {
        t.rotation = 90;
        t.x = def.width - def.hotspotX + 1 + LABEL_H - 4;
        t.y = -def.hotspotY - 4;
      }
    }
    ids.push(e.id);
    const row = s.rows.find((r) => r.num === num);
    if (row) delete row.spare;
    else s.rows.push({ num });
  });
  return ids;
}

/** how many terminals fit side by side (or one under the other) inside the frame of a sheet */
export function sheetCapacity(page: Page, def: ElementDef, dir: "h" | "v" = "h", pitch?: number): number {
  const b = page.border;
  const p = pitch ?? termPitch(def, dir, 10);
  const usable = dir === "h" ? b.cols * b.colW - 2 * b.colW : b.rows * b.rowH - 2.5 * b.rowH;
  return Math.max(1, Math.floor((usable - (dir === "h" ? def.width + LABEL_H : def.height)) / p) + 1);
}

/**
 * Place a long strip over several sheets: `perSheet` terminals on the start sheet, the rest on the
 * following sheets — new sheets (same frame and title block) are inserted after the start sheet,
 * titled "X1 terminals 2/3". Returns the new element ids and the sheets used.
 */
export function placeTerminalsOnSheets(
  doc: Doc,
  startPageId: string,
  tag: string,
  nums: string[],
  def: ElementDef,
  o: { dir?: "h" | "v"; perSheet: number; newElement: (doc: Doc, page: Page, def: ElementDef, at: { x: number; y: number }) => ElemInst; newPage: (order: number, title: string) => Page },
): { ids: string[]; pages: string[] } {
  const start = doc.pages.find((p) => p.id === startPageId);
  if (!start) return { ids: [], pages: [] };
  const per = Math.max(1, o.perSheet);
  const chunks: string[][] = [];
  for (let i = 0; i < nums.length; i += per) chunks.push(nums.slice(i, i + per));
  const ids: string[] = [], pages: string[] = [];
  let prev = start;
  const startFull = !freeSpot(doc, start, def, chunks[0]?.length ?? 0, o.dir ?? "h");
  chunks.forEach((chunk, k) => {
    let page = start;
    if (k > 0 || startFull) {
      page = o.newPage(prev.order + 1, chunks.length > 1 ? `${tag} terminals ${k + 1}/${chunks.length}` : `${tag} terminals`);
      page.border = { ...start.border };
      page.titleBlock = { ...start.titleBlock, fields: { ...start.titleBlock.fields, title: page.title } };
      // make room after the previous sheet
      for (const p of doc.pages) if (p.order > prev.order) p.order++;
      page.order = prev.order + 1;
      doc.pages.push(page);
      prev = page;
    }
    ids.push(...placeTerminals(doc, page, tag, chunk, def, { dir: o.dir, newElement: o.newElement }));
    pages.push(page.id);
  });
  return { ids, pages };
}

/** sheets the strip's terminals are drawn on, with counts (for the page-wise view) */
export function stripSheets(view: StripView): { sheet: number; pageId: string; count: number }[] {
  const m = new Map<string, { sheet: number; pageId: string; count: number }>();
  for (const r of view.rows)
    for (const pid of new Set(r.instances.map((x) => x.pageId))) {
      const inst = r.instances.find((x) => x.pageId === pid)!;
      const cur = m.get(pid) ?? { sheet: inst.sheet, pageId: pid, count: 0 };
      cur.count++;
      m.set(pid, cur);
    }
  return [...m.values()].sort((a, b) => a.sheet - b.sheet);
}

/** Remove the strip record of a strip that has no drawn terminals left. */
export function deleteStrip(doc: Doc, tag: string) {
  doc.terminalStrips = (doc.terminalStrips ?? []).filter((s) => s.tag !== tag);
}

/* ------------------------------------------------------------------ */
/* Terminal plan (table for the panel builder)                           */
/* ------------------------------------------------------------------ */

export const PLAN_COLUMNS = ["Strip", "Terminal", "Type", "Level", "Bridge", "Side 1 (top / left)", "Side 2 (bottom / right)", "Part number", "Sheets", "Note"] as const;

export function terminalPlanRows(doc: Doc, tags?: string[]): string[][] {
  const out: string[][] = [];
  for (const v of collectStrips(doc)) {
    if (tags && !tags.includes(v.tag)) continue;
    v.rows.forEach((r, i) => {
      const next = v.rows[i + 1];
      out.push([
        v.tag,
        r.num ?? "(unnumbered)",
        r.spare ? `${terminalTypeLabel(r.type)} (spare)` : terminalTypeLabel(r.type),
        r.row?.level ? String(r.row.level) : "",
        r.row?.bridge && next ? `→ ${next.num ?? "next"}` : "",
        r.side1.join("; "),
        r.side2.join("; "),
        r.row?.partNumber ?? v.strip?.partNumber ?? "",
        [...new Set(r.instances.map((x) => x.sheet))].join(", "),
        r.row?.note ?? "",
      ]);
    });
  }
  return out;
}

export function terminalPlanCsv(doc: Doc, tags?: string[]): string {
  const cell = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "﻿" + [PLAN_COLUMNS.join(","), ...terminalPlanRows(doc, tags).map((r) => r.map(cell).join(","))].join("\r\n") + "\r\n";
}

/** BOM data for terminals: part number per reference, and spare terminals. */
export function terminalBomInfo(doc: Doc): { partByRef: Map<string, { partNumber?: string; manufacturer?: string }>; spares: { ref: string; partNumber?: string; manufacturer?: string; type: TerminalType }[] } {
  const partByRef = new Map<string, { partNumber?: string; manufacturer?: string }>();
  const spares: { ref: string; partNumber?: string; manufacturer?: string; type: TerminalType }[] = [];
  for (const s of doc.terminalStrips ?? []) {
    for (const r of s.rows) {
      const pn = r.partNumber ?? s.partNumber;
      if (r.spare) spares.push({ ref: refOf(s, r.num), partNumber: pn, manufacturer: s.manufacturer, type: r.type ?? "feed" });
      else if (pn || s.manufacturer) partByRef.set(refOf(s, r.num), { partNumber: pn, manufacturer: s.manufacturer });
    }
  }
  return { partByRef, spares };
}
