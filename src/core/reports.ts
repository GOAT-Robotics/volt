/**
 * Folio reports (off-page arrows): a "going" arrow (QET next_report) on one sheet continues the
 * conductor at a "coming" arrow (previous_report) on another. Both carry the SAME reference
 * (the signal / potential name, e.g. "24V", "L1", "E-STOP-1"); the pair is linked by element id
 * (`ElemInst.links`, QElectroTech's <links_uuids>) so ERC, cross references, PDF links and the
 * "→ 5-3B" location text follow it.
 *
 * Linking happens automatically when the references match (one going arrow to one or more coming
 * arrows), or by hand in the inspector.
 */
import type { Doc, ElemInst, ElementDef, Page, Pt } from "./model";

export type ReportDir = "next_report" | "previous_report";
export const isReportDef = (d: ElementDef | undefined): boolean => d?.linkType === "next_report" || d?.linkType === "previous_report";
export const opposite = (lt: string): ReportDir => (lt === "next_report" ? "previous_report" : "next_report");

export type ReportOcc = { e: ElemInst; def: ElementDef; page: Page; sheet: number; dir: ReportDir };

export function allReports(doc: Doc): ReportOcc[] {
  const pages = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const out: ReportOcc[] = [];
  pages.forEach((page, i) => {
    for (const e of page.elements) {
      const def = doc.defs[e.defId];
      if (def && isReportDef(def)) out.push({ e, def, page, sheet: i + 1, dir: def.linkType as ReportDir });
    }
  });
  return out;
}

const find = (doc: Doc, id: string) => {
  for (const p of doc.pages) {
    const e = p.elements.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
};

export function linkReports(doc: Doc, a: string, b: string) {
  const ea = find(doc, a), eb = find(doc, b);
  if (!ea || !eb || a === b) return;
  ea.links = [...new Set([...(ea.links ?? []), b])];
  eb.links = [...new Set([...(eb.links ?? []), a])];
}

/** remove `id`'s report links (both directions); `other` = only that one */
export function unlinkReport(doc: Doc, id: string, other?: string) {
  const e = find(doc, id);
  if (!e) return;
  const gone = other ? [other] : [...(e.links ?? [])];
  e.links = (e.links ?? []).filter((l) => !gone.includes(l));
  if (!e.links.length) delete e.links;
  for (const g of gone) {
    const o = find(doc, g);
    if (!o?.links) continue;
    o.links = o.links.filter((l) => l !== id);
    if (!o.links.length) delete o.links;
  }
}

/**
 * Link report arrows that share a reference and are not linked yet: going ↔ coming. One going
 * arrow may feed several coming arrows (and vice versa); with several on both sides they pair up
 * in sheet order. Already linked arrows are left alone. Returns the number of new links.
 */
export function autoLinkReports(doc: Doc, onlyLabel?: string): number {
  const all = allReports(doc);
  const ids = new Set(all.map((r) => r.e.id));
  const free = (r: ReportOcc) => !(r.e.links ?? []).some((l) => ids.has(l));
  const by = new Map<string, ReportOcc[]>();
  for (const r of all) {
    const k = (r.e.info.label ?? "").trim();
    if (!k || (onlyLabel !== undefined && k !== onlyLabel.trim())) continue;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  let n = 0;
  for (const list of by.values()) {
    const going = list.filter((r) => r.dir === "next_report" && free(r));
    const coming = list.filter((r) => r.dir === "previous_report" && free(r));
    if (!going.length || !coming.length) continue;
    if (going.length === 1 || coming.length === 1) {
      for (const g of going) for (const c of coming) (linkReports(doc, g.e.id, c.e.id), n++);
    } else
      for (let i = 0; i < Math.min(going.length, coming.length); i++) (linkReports(doc, going[i].e.id, coming[i].e.id), n++);
  }
  return n;
}

/** arrows this one could be linked to: the other direction, other sheets first */
export function reportCandidates(doc: Doc, id: string): ReportOcc[] {
  const all = allReports(doc);
  const me = all.find((r) => r.e.id === id);
  if (!me) return [];
  return all
    .filter((r) => r.e.id !== id && r.dir === opposite(me.dir))
    .sort((a, b) => Number(a.page.id === me.page.id) - Number(b.page.id === me.page.id) || Number((b.e.info.label ?? "") === (me.e.info.label ?? "")) - Number((a.e.info.label ?? "") === (me.e.info.label ?? "")) || a.sheet - b.sheet);
}

/** "5-3B": sheet number and frame grid cell (column number, row letter) of a point */
export function sheetCell(doc: Doc, page: Page, p: Pt): string {
  const pages = [...doc.pages].filter((x) => !x.archived).sort((a, b) => a.order - b.order);
  const n = pages.findIndex((x) => x.id === page.id) + 1;
  const b = page.border;
  const hx = b.showRows ? b.headerW : 0, hy = b.showCols ? b.headerH : 0;
  const col = Math.floor((p.x - hx) / b.colW) + 1;
  const row = Math.floor((p.y - hy) / b.rowH);
  const cell = col >= 1 && col <= b.cols && row >= 0 && row < b.rows ? `${col}${String.fromCharCode(65 + (row % 26))}` : "";
  return cell ? `${n}-${cell}` : `${n}`;
}

/** location text shown at a linked arrow: where the conductor continues ("→ 5-3B", several joined with ", ") */
export function reportTarget(doc: Doc, e: ElemInst): string | null {
  if (!e.links?.length) return null;
  const parts: string[] = [];
  for (const l of e.links)
    for (const p of doc.pages) {
      const o = p.elements.find((x) => x.id === l);
      if (o && !p.archived) parts.push(sheetCell(doc, p, { x: o.x, y: o.y }));
    }
  return parts.length ? parts.join(", ") : null;
}

/** a 1-pin symbol that looks like an off-page arrow but has no report link type (library symbol not marked) */
export function looksLikeArrow(def: ElementDef | undefined): boolean {
  if (!def || def.linkType || def.pins.length !== 1) return false;
  const s = [def.name, ...Object.values(def.names), def.category, def.source?.path ?? ""].join(" ").toLowerCase();
  return /report|renvoi|arrow|off.?page|folio|flèche|fleche|continu|verweis|querverweis|link/.test(s);
}
