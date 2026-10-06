import { isTerminalDef } from "./terminals";
import type { Doc, ElemInst, ElementDef, NumberingRule, Page } from "./model";

export type RefChange = { pageId: string; elId: string; from: string; to: string };

const parseRef = (ref: string) => {
  const m = /^(.*?)(\d+)$/.exec(ref);
  return m ? { prefix: m[1], n: Number(m[2]) } : null;
};

export function ruleFor(doc: Doc, def: ElementDef | undefined): NumberingRule | undefined {
  const rules = doc.numbering.rules;
  if (!def) return rules.find((r) => r.match === "*");
  return rules.find((r) => r.match !== "*" && (r.match === def.prefix || (def.category && def.category.startsWith(r.match)))) ?? rules.find((r) => r.match === "*");
}

export function prefixFor(doc: Doc, def: ElementDef | undefined): string {
  const r = ruleFor(doc, def);
  return (r?.prefix || def?.prefix || "").trim();
}

function fmt(rule: NumberingRule, prefix: string, n: number, pageNo: number, location: string): string {
  return rule.format.replace(/\{(\w+)(?::(\d+))?\}/g, (_, k: string, w?: string) => {
    if (k === "prefix") return prefix;
    if (k === "n") return w ? String(n).padStart(Number(w), "0") : String(n);
    if (k === "page") return String(pageNo);
    if (k === "location") return location;
    return "";
  });
}

function scopeKey(rule: NumberingRule, pageId: string, e: ElemInst): string {
  return rule.scope === "page" ? pageId : rule.scope === "location" ? e.info.location ?? "" : "*";
}

/** Next free reference for a newly placed element. */
export function nextRef(doc: Doc, page: Page, e: ElemInst): string {
  const def = doc.defs[e.defId];
  if (!def || def.pins.length === 0) return "";
  if (def.linkType === "next_report" || def.linkType === "previous_report" || def.name === "volt_junction") return "";
  const rule = ruleFor(doc, def);
  const prefix = prefixFor(doc, def);
  if (!rule || !prefix) return "";
  const pages = [...doc.pages].sort((a, b) => a.order - b.order);
  const pageNo = pages.findIndex((p) => p.id === page.id) + 1;
  // references must be unique project-wide (duplicateRefs / planRenumber treat them so): the scope only
  // matters through the format tokens ({page}, {location}), so every existing label is taken
  const used = new Set<string>();
  for (const p of pages)
    for (const x of p.elements) {
      if (x.id === e.id) continue;
      if (x.info.label) used.add(x.info.label);
    }
  for (let n = rule.start; n < 100000; n++) {
    const r = fmt(rule, prefix, n, pageNo, e.info.location ?? "");
    if (!used.has(r)) return r;
  }
  return "";
}

/** Plan a renumbering (preview). Locked refs are kept and reserved. Order: page → column (x) → row (y). */
export function planRenumber(doc: Doc, pageIds: string[] | "all", onlyEmpty = false): RefChange[] {
  const pages = [...doc.pages].sort((a, b) => a.order - b.order);
  const target = new Set(pageIds === "all" ? pages.map((p) => p.id) : pageIds);
  const reserved = new Set<string>();
  for (const p of pages) for (const e of p.elements) if (e.refLocked || !target.has(p.id) || (onlyEmpty && e.info.label)) if (e.info.label) reserved.add(e.info.label);
  const counters = new Map<string, number>();
  const changes: RefChange[] = [];
  pages.forEach((p, pi) => {
    if (!target.has(p.id)) return;
    const els = [...p.elements].sort((a, b) => Math.round(a.x / 20) - Math.round(b.x / 20) || a.y - b.y);
    for (const e of els) {
      if (e.refLocked) continue;
      if (onlyEmpty && e.info.label) continue;
      const def = doc.defs[e.defId];
      if (!def || def.pins.length === 0 || def.name === "volt_junction") continue;
      if (def.linkType === "next_report" || def.linkType === "previous_report") continue;
      const rule = ruleFor(doc, def);
      const prefix = prefixFor(doc, def);
      if (!rule || !prefix) continue;
      const ck = `${rule.id}|${prefix}|${scopeKey(rule, p.id, e)}`;
      let n = counters.get(ck) ?? rule.start;
      let ref = fmt(rule, prefix, n, pi + 1, e.info.location ?? "");
      while (reserved.has(ref)) ref = fmt(rule, prefix, ++n, pi + 1, e.info.location ?? "");
      counters.set(ck, n + 1);
      reserved.add(ref);
      if ((e.info.label ?? "") !== ref) changes.push({ pageId: p.id, elId: e.id, from: e.info.label ?? "", to: ref });
    }
  });
  return changes;
}

export function duplicateRefs(doc: Doc): Map<string, { pageId: string; elId: string }[]> {
  const m = new Map<string, { pageId: string; elId: string }[]>();
  for (const p of doc.pages)
    for (const e of p.elements) {
      const r = e.info.label;
      if (!r) continue;
      const def = doc.defs[e.defId];
      // master/slave cross references legitimately share a label
      if (def && (def.linkType === "slave" || def.linkType === "next_report" || def.linkType === "previous_report")) continue;
      // a terminal may be drawn several times (schematic, cabinet view…): equal references are the same terminal
      if (isTerminalDef(def)) continue;
      const arr = m.get(r) ?? [];
      arr.push({ pageId: p.id, elId: e.id });
      m.set(r, arr);
    }
  for (const [k, v] of m) if (v.length < 2) m.delete(k);
  return m;
}

export { parseRef };
