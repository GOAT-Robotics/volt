import type { Doc, Page, Rect } from "./model";
import { duplicateRefs, prefixFor } from "./numbering";
import { docStyles, layoutElementTexts, textBounds } from "./render/scene";
import { symbolFor } from "./render/symbol";
import { approxMeasure } from "./render/svg";
import { rectsIntersect } from "./geometry";

export type IssueLevel = "error" | "warning" | "info";
export type Issue = { level: IssueLevel; code: string; message: string; pageId?: string; ids: string[] };

export type ValidateContext = {
  /** latest library revisions keyed by libraryElementId (for broken/outdated library refs) */
  library?: Record<string, { revision: number; status: string } | null>;
  measure?: (t: string, size: number, font: string, weight?: number) => number;
};

export function validateDoc(doc: Doc, ctx: ValidateContext = {}): Issue[] {
  const issues: Issue[] = [];
  const styles = docStyles(doc);
  const measure = ctx.measure ?? approxMeasure;
  const pages = [...doc.pages].sort((a, b) => a.order - b.order);

  // duplicate page titles
  const titles = new Map<string, string[]>();
  for (const p of pages) titles.set(p.title.trim().toLowerCase(), [...(titles.get(p.title.trim().toLowerCase()) ?? []), p.id]);
  for (const [t, ids] of titles) if (ids.length > 1) issues.push({ level: "warning", code: "page.duplicate", message: `${ids.length} pages share the title "${t}"`, ids });

  // duplicate references
  for (const [ref, occ] of duplicateRefs(doc))
    issues.push({ level: "error", code: "ref.duplicate", message: `Reference ${ref} is used ${occ.length} times`, pageId: occ[0].pageId, ids: occ.map((o) => o.elId) });

  // definitions
  for (const [id, def] of Object.entries(doc.defs)) {
    if (def.placeholder) issues.push({ level: "warning", code: "def.missing", message: `Element definition not available: ${def.name || id}`, ids: [] });
    const nums = def.pins.map((p) => p.number).filter(Boolean);
    const dupe = nums.find((n, i) => nums.indexOf(n) !== i);
    if (dupe) issues.push({ level: "warning", code: "def.pinDuplicate", message: `${def.name}: pin number ${dupe} is used twice`, ids: [] });
    const src = def.source?.libraryElementId;
    if (src && ctx.library) {
      const lib = ctx.library[src];
      if (lib === null) issues.push({ level: "warning", code: "lib.broken", message: `${def.name}: source library element no longer exists`, ids: [] });
      else if (lib && lib.revision > (def.source?.revision ?? 0)) issues.push({ level: "info", code: "lib.outdated", message: `${def.name}: library revision ${lib.revision} available (using ${def.source?.revision})`, ids: [] });
      else if (lib?.status === "DEPRECATED") issues.push({ level: "warning", code: "lib.deprecated", message: `${def.name}: library element is deprecated`, ids: [] });
    }
  }

  for (const page of pages) validatePage(doc, page, issues, styles, measure);
  const order: Record<IssueLevel, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}

function validatePage(doc: Doc, page: Page, issues: Issue[], styles: ReturnType<typeof docStyles>, measure: NonNullable<ValidateContext["measure"]>) {
  const els = new Map(page.elements.map((e) => [e.id, e]));
  const juncs = new Set(page.junctions.map((j) => j.id));
  const connected = new Set<string>();
  const P = page.title;
  for (const w of page.wires) {
    for (const end of [w.a, w.b]) {
      if (end.k === "free") continue;
      if (end.k === "pin") {
        const e = els.get(end.el);
        const def = e && doc.defs[e.defId];
        if (!e || !def?.pins.some((p) => p.id === end.pin)) issues.push({ level: "error", code: "wire.broken", message: `${P}: wire references a missing pin`, pageId: page.id, ids: [w.id] });
        connected.add(end.el + "/" + end.pin);
      } else if (!juncs.has(end.j)) issues.push({ level: "error", code: "wire.broken", message: `${P}: wire references a missing junction`, pageId: page.id, ids: [w.id] });
    }
    if (w.a.k === "free" || w.b.k === "free") issues.push({ level: "warning", code: "wire.dangling", message: `${P}: dangling wire end${w.label ? ` (${w.label})` : ""}`, pageId: page.id, ids: [w.id] });
    if (w.pts.length >= 2) {
      let len = 0;
      for (let i = 1; i < w.pts.length; i++) len += Math.abs(w.pts[i].x - w.pts[i - 1].x) + Math.abs(w.pts[i].y - w.pts[i - 1].y);
      if (len < 0.5) issues.push({ level: "info", code: "wire.zero", message: `${P}: zero-length wire`, pageId: page.id, ids: [w.id] });
    }
  }
  const labelRects: { r: Rect; id: string; text: string }[] = [];
  for (const e of page.elements) {
    const def = doc.defs[e.defId];
    if (!def) {
      issues.push({ level: "error", code: "elem.nodef", message: `${P}: element without definition`, pageId: page.id, ids: [e.id] });
      continue;
    }
    if (def.name === "volt_junction") continue;
    const needsRef = def.pins.length > 0 && !!prefixFor(doc, def) && def.linkType !== "next_report" && def.linkType !== "previous_report";
    if (needsRef && !e.info.label) issues.push({ level: "warning", code: "ref.missing", message: `${P}: ${def.name} has no reference`, pageId: page.id, ids: [e.id] });
    for (const pin of def.pins) if (pin.required && !connected.has(e.id + "/" + pin.id)) issues.push({ level: "warning", code: "pin.unconnected", message: `${P}: ${e.info.label || def.name} pin ${pin.number || pin.name || pin.id} must be connected`, pageId: page.id, ids: [e.id] });
    for (const t of layoutElementTexts(e, symbolFor(def), styles, measure)) labelRects.push({ r: textBounds(t), id: e.id, text: t.text });
  }
  // overlapping labels (bucketed)
  const bucket = new Map<string, number[]>();
  const B = 80;
  labelRects.forEach((l, i) => {
    for (let x = Math.floor(l.r.x / B); x <= Math.floor((l.r.x + l.r.w) / B); x++)
      for (let y = Math.floor(l.r.y / B); y <= Math.floor((l.r.y + l.r.h) / B); y++) {
        const k = x + ":" + y;
        bucket.set(k, [...(bucket.get(k) ?? []), i]);
      }
  });
  const seen = new Set<string>();
  for (const ids of bucket.values())
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = labelRects[ids[i]], b = labelRects[ids[j]];
        if (a.id === b.id) continue;
        const k = ids[i] < ids[j] ? ids[i] + "-" + ids[j] : ids[j] + "-" + ids[i];
        if (seen.has(k)) continue;
        seen.add(k);
        const shrink = (r: Rect) => ({ x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) });
        if (rectsIntersect(shrink(a.r), shrink(b.r))) issues.push({ level: "warning", code: "label.overlap", message: `${P}: labels "${a.text}" and "${b.text}" overlap`, pageId: page.id, ids: [a.id, b.id] });
      }
}
