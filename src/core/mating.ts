/**
 * Mated connectors: a plug (male) and a socket (female) — or any two components — linked as
 * one connection. Their pins connect pairwise by pin number (then name, then order), so nets
 * run through the pair; references cross-link (click one to go to the other).
 */
import type { Doc, ElemInst, ElementDef, Page } from "./model";

export type Gender = "male" | "female";

export function findElement(doc: Doc, id: string): { page: Page; e: ElemInst } | null {
  for (const page of doc.pages) {
    const e = page.elements.find((x) => x.id === id);
    if (e) return { page, e };
  }
  return null;
}

/** male / female from the symbol's names and category (null if it says neither) */
export function guessGender(def: ElementDef | undefined): Gender | null {
  if (!def) return null;
  const s = [def.name, ...Object.values(def.names), def.category].join(" ").toLowerCase();
  if (/female|socket|receptacle|jack|femelle|buchse|kupplung|coupler/.test(s)) return "female";
  if (/\bmale\b|plug|header|stecker|mâle|\bpin\b/.test(s)) return "male";
  return null;
}

/** a plug / socket connector (terminal blocks and ordinary components are not) */
export function isConnector(def: ElementDef | undefined): boolean {
  if (!def || !def.pins.length || def.linkType === "terminal") return false;
  const s = [def.name, ...Object.values(def.names), def.category].join(" ").toLowerCase();
  if (/terminal|borne|klemme|junction/.test(s)) return false;
  return guessGender(def) !== null || /connector|connecteur|steckverbinder|conector|harness/.test(s);
}

/** pin pairs of two mated definitions: by number, then by name, then by order */
export function matedPinPairs(a: ElementDef, b: ElementDef): { a: string; b: string; label: string }[] {
  const out: { a: string; b: string; label: string }[] = [];
  const used = new Set<string>();
  const key = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  for (const pa of a.pins) {
    const pb = b.pins.find((x) => !used.has(x.id) && key(x.number) && key(x.number) === key(pa.number)) ?? b.pins.find((x) => !used.has(x.id) && key(x.name) && key(x.name) === key(pa.name));
    if (pb) {
      used.add(pb.id);
      out.push({ a: pa.id, b: pb.id, label: pa.number || pa.name || pb.number || "" });
    }
  }
  if (!out.length && a.pins.length === b.pins.length) a.pins.forEach((pa, i) => out.push({ a: pa.id, b: b.pins[i].id, label: pa.number || String(i + 1) }));
  return out;
}

/** links a ↔ b (clearing earlier mates of both) */
export function setMate(doc: Doc, aId: string, bId: string, genderOfA: Gender) {
  if (aId === bId) return;
  clearMate(doc, aId);
  clearMate(doc, bId);
  const a = findElement(doc, aId), b = findElement(doc, bId);
  if (!a || !b) return;
  a.e.mate = { id: bId, gender: genderOfA };
  b.e.mate = { id: aId, gender: genderOfA === "male" ? "female" : "male" };
}

export function clearMate(doc: Doc, id: string) {
  const x = findElement(doc, id);
  if (!x?.e.mate) return;
  const other = findElement(doc, x.e.mate.id);
  if (other?.e.mate?.id === id) delete other.e.mate;
  delete x.e.mate;
}

/** pin-to-pin connections made by mated pairs on one page (for nets) */
export function pageMateLinks(doc: Doc, page: Page): [string, string][] {
  const out: [string, string][] = [];
  const byId = new Map(page.elements.map((e) => [e.id, e]));
  for (const e of page.elements) {
    if (!e.mate || e.mate.gender !== "male") continue;
    const o = byId.get(e.mate.id);
    const da = doc.defs[e.defId], db = o && doc.defs[o.defId];
    if (!o || !da || !db) continue;
    for (const p of matedPinPairs(da, db)) out.push([`p:${e.id}/${p.a}`, `p:${o.id}/${p.b}`]);
  }
  return out;
}

/** "−X1 (sheet 3)" for the counterpart of a mated element */
export function mateLabel(doc: Doc, e: ElemInst, pageOf?: Page): string | null {
  if (!e.mate) return null;
  const o = findElement(doc, e.mate.id);
  if (!o) return null;
  const label = o.e.info.label || doc.defs[o.e.defId]?.name || "?";
  if (pageOf && o.page.id === pageOf.id) return label;
  const n = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order).findIndex((p) => p.id === o.page.id) + 1;
  return `${label} /${n}`;
}
