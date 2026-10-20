/**
 * MCP edits for label placement: a component's labels (reference, description lines, an off-page
 * arrow's cross-reference, a connector's counterpart label) and a cable's tag.
 */
import type { Doc, ElemInst, Page } from "@/core/model";
import { getPage } from "@/core/ops";
import { approxMeasure } from "@/core/render/svg";
import { docStyles } from "@/core/render/scene";
import { isReportDef } from "@/core/reports";
import { componentLabels, placeCableTag, placeLabels, type LabelKind, type Side } from "@/core/label-place";
import { gridRef } from "@/core/xref";
import { findComponents, findPage, sheetNo, short } from "./doc";
import { EditError } from "./edits";

export type LabelWhich = "reference" | "description" | "xref" | "mate" | "all";

const KIND_WORD: Record<LabelKind, string> = { reference: "reference", description: "description", xref: "cross-reference", mate: "counterpart label" };
const kindsOf = (w: LabelWhich[]): LabelKind[] => (w.includes("all") ? ["reference", "description", "xref", "mate"] : [...new Set(w as LabelKind[])]);

/**
 * Move the labels of components: by dx / dy, to a side of the symbol, or back to their default
 * places. components = references (each part they name), or "all" on a page (only_arrows: just
 * the off-page arrows there).
 */
export function moveLabels(doc: Doc, refs: string[] | "all", which: LabelWhich[], o: { side?: Side; dx?: number; dy?: number; reset?: boolean; page?: string; onlyArrows?: boolean }): string {
  if (!o.side && !o.dx && !o.dy && !o.reset) throw new EditError("Say where: side, dx / dy, or reset");
  const kinds = kindsOf(which.length ? which : ["all"]);
  const pageFilter = o.page !== undefined ? findPage(doc, o.page) : null;
  let targets: { e: ElemInst; page: Page }[] = [];
  if (refs === "all") {
    if (!pageFilter) throw new EditError('components "all" needs a page');
    targets = pageFilter.elements.map((e) => ({ e, page: pageFilter }));
  } else
    for (const r of refs) {
      const found = findComponents(doc, r).filter((x) => !pageFilter || x.page.id === pageFilter.id);
      if (!found.length) throw new EditError(`${r} is not on page ${pageFilter ? sheetNo(doc, pageFilter) : "?"}`);
      targets.push(...found.map((x) => ({ e: x.e, page: x.page })));
    }
  if (o.onlyArrows) targets = targets.filter((t) => isReportDef(doc.defs[t.e.defId]));
  if (!targets.length) throw new EditError(o.onlyArrows ? "No off-page arrows there" : "No components there");
  const styles = docStyles(doc);
  const lines: string[] = [];
  let none = 0;
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.e.id)) continue;
    seen.add(t.e.id);
    const page = getPage(doc, t.page.id);
    const e = page.elements.find((x) => x.id === t.e.id)!;
    const has = componentLabels(doc, page, e, styles, approxMeasure).filter((l) => kinds.includes(l.kind));
    if (!has.length) {
      none++;
      continue;
    }
    const after = placeLabels(doc, page, e, kinds, { side: o.side, dx: o.dx, dy: o.dy, reset: o.reset }, styles, approxMeasure);
    const name = `${e.info.label || short(e.id)}@${sheetNo(doc, page)}`;
    lines.push(`${name}: ${[...new Set(after.map((l) => l.kind))].map((k) => { const b = after.filter((l) => l.kind === k).map((l) => l.box); const x = Math.min(...b.map((r) => r.x)), y = Math.min(...b.map((r) => r.y)); return `${KIND_WORD[k]} at ${Math.round(x)},${Math.round(y)}`; }).join(", ")}`);
  }
  if (!lines.length) throw new EditError(`None of them shows ${kinds.map((k) => KIND_WORD[k]).join(" / ")}`);
  const how = o.reset ? "back to the default place" : [o.side && (o.side === "above" || o.side === "below" ? `${o.side} the symbol` : `to the ${o.side} of the symbol`), (o.dx || o.dy) && `by (${o.dx ?? 0}, ${o.dy ?? 0})`].filter(Boolean).join(", then ");
  const shown = lines.length > 40 ? [...lines.slice(0, 40), `… and ${lines.length - 40} more`] : lines;
  return `Moved the ${kinds.map((k) => KIND_WORD[k]).join(" / ")} of ${lines.length} component${lines.length === 1 ? "" : "s"} ${how}${none ? ` (${none} show none of these)` : ""}:\n${shown.join("\n")}`;
}

/** Move a cable's tag on one sheet (or every sheet it is drawn on). */
export function moveCableTag(doc: Doc, tag: string, o: { page?: string; along?: number; at?: number; side?: Side; dx?: number; dy?: number; reset?: boolean }): string {
  const cable = (doc.cables ?? []).find((c) => c.tag.toLowerCase() === tag.trim().toLowerCase());
  if (!cable) throw new EditError(`No cable ${tag} — list_cables shows them`);
  if (o.along === undefined && o.at === undefined && !o.side && !o.dx && !o.dy && !o.reset) throw new EditError("Say where: along / at, side, dx / dy, or reset");
  if (o.along !== undefined && o.at !== undefined) throw new EditError("Give along or at, not both");
  const drawn = doc.pages.filter((p) => p.wires.some((w) => w.cable === cable.tag));
  if (!drawn.length) throw new EditError(`${cable.tag} has no wires on any sheet yet`);
  const pages = o.page !== undefined ? [findPage(doc, o.page)] : drawn;
  if (o.page === undefined && drawn.length > 1 && (o.along !== undefined || o.at !== undefined)) throw new EditError(`${cable.tag} is drawn on pages ${drawn.map((p) => sheetNo(doc, p)).join(", ")} — give the page to slide its mark`);
  const styles = docStyles(doc);
  const out: string[] = [];
  for (const p0 of pages) {
    const page = getPage(doc, p0.id);
    const r = placeCableTag(doc, page, cable.tag, o, styles, approxMeasure);
    if (!r) {
      if (o.page !== undefined) throw new EditError(`${cable.tag} has no wires on page ${sheetNo(doc, page)}`);
      continue;
    }
    const pos = r.horizontal ? (r.mark.a.x + r.mark.b.x) / 2 : (r.mark.a.y + r.mark.b.y) / 2;
    const along = r.hi > r.lo ? Math.round(((pos - r.lo) / (r.hi - r.lo)) * 100) / 100 : 0.5;
    out.push(`page ${sheetNo(doc, page)}: mark at ${r.horizontal ? "x" : "y"} = ${Math.round(pos)} (along ${along} of ${Math.round(r.lo)}–${Math.round(r.hi)}), tag at ${Math.round(r.box.x)},${Math.round(r.box.y)} (${gridRef(doc, page, { x: r.box.x, y: r.box.y }) || "off the grid"})`);
  }
  return `${cable.tag} tag ${o.reset ? "back to automatic" : "moved"} — ${out.join("; ")}`;
}
