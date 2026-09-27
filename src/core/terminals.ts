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
import { computeNets } from "./topology";
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
};
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

const netCache = new WeakMap<Page["wires"], ReturnType<typeof computeNets>>();
function netsOf(page: Page, doc: Doc) {
  let n = netCache.get(page.wires);
  if (!n) netCache.set(page.wires, (n = computeNets(page, doc)));
  return n;
}

/** Destinations of one terminal instance, per side: "Q1:2 (W1 BN)" */
function connections(doc: Doc, f: Found): { side1: string[]; side2: string[] } {
  const side1: string[] = [], side2: string[] = [];
  const nets = netsOf(f.page, doc);
  const els = new Map(f.page.elements.map((x) => [x.id, x]));
  for (const pin of f.def.pins) {
    const o = rotOrient(pin.orient, f.e.rot, f.e.mirror);
    const into = o === "n" || o === "w" ? side1 : side2;
    const net = nets.find((n) => n.pins.some((p) => p.el === f.e.id && p.pin === pin.id));
    if (!net) continue;
    const wire = f.page.wires.find((w: Wire) => (w.a.k === "pin" && w.a.el === f.e.id && w.a.pin === pin.id) || (w.b.k === "pin" && w.b.el === f.e.id && w.b.pin === pin.id));
    const targets = net.pins
      .filter((p) => p.el !== f.e.id)
      .map((p) => {
        const x = els.get(p.el);
        const d = x && doc.defs[x.defId];
        const pd = d?.pins.find((q) => q.id === p.pin);
        const ref = x?.info.label || d?.names.en || d?.name || "?";
        const pn = pd?.number || pd?.name;
        return pn ? `${ref}:${pn}` : ref;
      });
    let extra = "";
    if (wire) {
      const wi = wireInfo(doc, wire);
      const parts = [wire.cable ? `${wire.cable}${wire.core ? ` ${wire.core}` : ""}` : "", wire.label ?? "", !wire.cable && wi.section ? wi.section : ""].filter(Boolean);
      if (parts.length) extra = ` (${parts.join(" · ")})`;
    }
    const text = (targets.length ? [...new Set(targets)].join(", ") : "—") + extra;
    if (!into.includes(text)) into.push(text);
  }
  return { side1, side2 };
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
      const key = f.num ?? `@${f.e.id}`;
      let r = byKey.get(key);
      if (!r) {
        r = { key, num: f.num, instances: [], row: null, type: defTerminalType(f.def), spare: false, symbol: f.def.names.en ?? f.def.name, side1: [], side2: [] };
        byKey.set(key, r);
      }
      r.instances.push({ el: f.e.id, pageId: f.page.id, sheet: f.sheet });
      const c = connections(doc, f);
      for (const t of c.side1) if (!r.side1.includes(t)) r.side1.push(t);
      for (const t of c.side2) if (!r.side2.includes(t)) r.side2.push(t);
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
        rows.push({ key: `spare:${sr.num}`, num: sr.num, instances: [], row: sr, type: sr.type ?? "feed", spare: true, symbol: "", side1: [], side2: [] });
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
