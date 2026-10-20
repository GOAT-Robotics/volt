/**
 * Where a component's labels sit, and moving them: the reference (its name), the description lines
 * (component info block and other info texts), an off-page arrow's cross-reference ("5-3B") and a
 * mated connector's counterpart label. Shared by the editor (dragging) and the MCP tools.
 */
import type { Doc, ElemInst, Page, Pt, Rect, Styles } from "./model";
import { toLocal, unionRect } from "./geometry";
import { cableLabelRect, elementBounds, layoutElementTexts, mateLabelLayout, reportLabelLayout, textBounds } from "./render/scene";
import { computeCableMarks } from "./wiring";
import { isReportDef } from "./reports";
import { symbolFor } from "./render/symbol";
import type { Painter } from "./render/painter";

/** "sub" ids of the labels that are not component texts */
export const INFO_BLOCK = "\u0000info";
export const MATE_LABEL = "\u0000mate";
export const XREF_LABEL = "\u0000xref";

export type LabelKind = "reference" | "description" | "xref" | "mate";
export type Side = "right" | "left" | "above" | "below";
type Measure = Painter["measure"];

/** one movable label of a component: what it is, its id (a text id or one of the ids above) and its box */
export type ComponentLabel = { kind: LabelKind; id: string; box: Rect };

const round = (v: number) => Math.round(v * 2) / 2;

/** the labels a component shows, with their boxes (scene units) */
export function componentLabels(doc: Doc, page: Page, e: ElemInst, styles: Styles, measure: Measure): ComponentLabel[] {
  const def = doc.defs[e.defId];
  if (!def) return [];
  const out: ComponentLabel[] = [];
  let block: Rect | null = null;
  for (const lt of layoutElementTexts(e, symbolFor(def), styles, measure)) {
    const b = textBounds(lt);
    if (lt.block) {
      block = unionRect(block, b);
      continue;
    }
    const t = lt.textId ? e.texts.find((x) => x.id === lt.textId) : undefined;
    if (!t) continue;
    out.push({ kind: t.info === "label" ? "reference" : "description", id: t.id, box: b });
  }
  if (block) out.push({ kind: "description", id: INFO_BLOCK, box: block });
  const rl = isReportDef(def) && e.links?.length ? reportLabelLayout(doc, e, def, styles, measure) : null;
  if (rl) out.push({ kind: "xref", id: XREF_LABEL, box: { x: rl.x, y: rl.y, w: rl.w, h: rl.h } });
  const ml = e.mate ? mateLabelLayout(doc, e, def, page, styles, measure) : null;
  if (ml) out.push({ kind: "mate", id: MATE_LABEL, box: { x: ml.x, y: ml.y, w: ml.w, h: ml.h } });
  return out;
}

/** Move one label of a component by a scene distance (what dragging it in the editor does). */
export function moveLabel(doc: Doc, page: Page, e: ElemInst, id: string, delta: Pt, styles: Styles, measure: Measure) {
  const def = doc.defs[e.defId];
  if (!def) return;
  if (id === MATE_LABEL) {
    // counterpart label: remembered relative to the component (it follows it)
    const cur = e.mate && mateLabelLayout(doc, e, def, page, styles, measure);
    if (!e.mate || !cur) return;
    e.mate.labelPos = { x: round(cur.x + delta.x - e.x), y: round(cur.y + delta.y - e.y) };
    e.mate.label = "show";
    return;
  }
  if (id === XREF_LABEL) {
    const cur = isReportDef(def) ? reportLabelLayout(doc, e, def, styles, measure) : null;
    if (!cur) return;
    e.xrefPos = { x: round(cur.x + delta.x - e.x), y: round(cur.y + delta.y - e.y) };
    return;
  }
  if (id === INFO_BLOCK) {
    // component info block: its top-left in element coordinates (it follows the component). Placed
    // freely it reads left to right, so a block that ran along a turned reference changes shape:
    // its box (not its anchor) is what moves by delta.
    const blockBox = () => {
      let r: Rect | null = null;
      let anchor: Pt | null = null;
      for (const t of layoutElementTexts(e, symbolFor(def), styles, measure))
        if (t.block) ((r = unionRect(r, textBounds(t))), (anchor ??= t.block));
      return r && anchor ? { r, anchor } : null;
    };
    const before = blockBox();
    if (!before) return;
    const target = { x: before.r.x + delta.x, y: before.r.y + delta.y };
    const set = (scene: Pt) => {
      const p = toLocal(e, scene);
      e.infoLayout = { ...(e.infoLayout ?? {}), at: "free", pos: { x: round(p.x), y: round(p.y) } };
    };
    set(before.anchor);
    const now = blockBox();
    if (now) set({ x: now.anchor.x + target.x - now.r.x, y: now.anchor.y + target.y - now.r.y });
    return;
  }
  const t = e.texts.find((x) => x.id === id);
  if (!t) return;
  const boxOf = () => {
    const lt = layoutElementTexts(e, symbolFor(def), styles, measure).find((x) => x.textId === t.id);
    return lt ? textBounds(lt) : null;
  };
  const before = boxOf();
  if (!before) return;
  // an automatically placed text gets a fixed place first (then it is moved from where it now is)
  if (t.x === null || t.y === null) {
    const bb = symbolFor(def).bbox;
    ((t.x = bb.x + bb.w), (t.y = bb.y));
  }
  const now = boxOf() ?? before;
  // the scene distance in the component's own coordinates (its rotation, mirroring and size undone)
  let lx = before.x + delta.x - now.x, ly = before.y + delta.y - now.y;
  for (let i = 0; i < e.rot; i++) [lx, ly] = [ly, -lx];
  if (e.mirror) lx = -lx;
  const k = e.scale && e.scale > 0 ? e.scale : 1;
  ((lx /= k), (ly /= k));
  t.x = round(t.x + lx);
  t.y = round(t.y + ly);
}

/** Put a label back where it goes by default. */
export function resetLabel(doc: Doc, e: ElemInst, id: string) {
  if (id === MATE_LABEL) {
    if (e.mate) {
      delete e.mate.labelPos;
      if (e.mate.label === "show") delete e.mate.label;
    }
    return;
  }
  if (id === XREF_LABEL) return void delete e.xrefPos;
  if (id === INFO_BLOCK) {
    if (e.infoLayout?.at === "free") {
      const { at: _a, pos: _p, ...rest } = e.infoLayout;
      void _a;
      void _p;
      if (Object.keys(rest).length) e.infoLayout = rest;
      else delete e.infoLayout;
    }
    return;
  }
  const t = e.texts.find((x) => x.id === id);
  if (!t) return;
  const def = doc.defs[e.defId];
  // the position the symbol gives the text, else the automatic one
  const dp = def?.prims.find((p) => p.t === "dyntext" && ((t.uuid && p.uuid === t.uuid) || (p.info === t.info && t.info)));
  if (dp && dp.t === "dyntext") ((t.x = dp.x), (t.y = dp.y));
  else ((t.x = null), (t.y = null));
}

const KIND_ORDER: LabelKind[] = ["reference", "description", "xref", "mate"];

/**
 * Move the chosen labels of a component: by dx / dy, and / or to one side of its symbol (stacked
 * in the order reference, description, cross-reference, counterpart), or back to their default
 * places. Returns what was moved.
 */
export function placeLabels(doc: Doc, page: Page, e: ElemInst, kinds: LabelKind[], o: { side?: Side; dx?: number; dy?: number; reset?: boolean; gap?: number }, styles: Styles, measure: Measure): ComponentLabel[] {
  const def = doc.defs[e.defId];
  if (!def) return [];
  const want = new Set(kinds);
  const pick = () => componentLabels(doc, page, e, styles, measure).filter((l) => want.has(l.kind)).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  let labels = pick();
  if (!labels.length) return [];
  if (o.reset) {
    for (const l of labels) resetLabel(doc, e, l.id);
    labels = pick();
  }
  // targets first, then each label moved from wherever it is by then (moving the reference also
  // carries an automatically placed description block along)
  const moveTo = (targets: Map<string, Pt>) => {
    for (const l of labels) {
      const to = targets.get(l.id);
      const cur = componentLabels(doc, page, e, styles, measure).find((x) => x.id === l.id)?.box;
      if (to && cur) moveLabel(doc, page, e, l.id, { x: to.x - cur.x, y: to.y - cur.y }, styles, measure);
    }
    labels = pick();
  };
  // twice: a label can change shape when it is first placed freely (a block that ran along a turned reference)
  for (let pass = 0; o.side && pass < 2; pass++) {
    const body = elementBounds(e, def);
    const gap = o.gap ?? 2;
    const W = Math.max(...labels.map((l) => l.box.w));
    const H = labels.reduce((t, l) => t + l.box.h, 0) + (labels.length - 1) * 0.5;
    // the stack's top-left, then each label in turn (left-aligned beside, centred above / below)
    const x0 = o.side === "right" ? body.x + body.w + gap : o.side === "left" ? body.x - gap - W : body.x + body.w / 2 - W / 2;
    let y = o.side === "above" ? body.y - gap - H : o.side === "below" ? body.y + body.h + gap : body.y + body.h / 2 - H / 2;
    const targets = new Map<string, Pt>();
    for (const l of labels) {
      targets.set(l.id, { x: o.side === "left" ? x0 + W - l.box.w : o.side === "right" ? x0 : x0 + (W - l.box.w) / 2, y });
      y += l.box.h + 0.5;
    }
    moveTo(targets);
  }
  if (o.dx || o.dy) moveTo(new Map(labels.map((l) => [l.id, { x: l.box.x + (o.dx ?? 0), y: l.box.y + (o.dy ?? 0) }])));
  return labels;
}

/* ------------------------------------------------------------------ */
/* Cable tags                                                           */
/* ------------------------------------------------------------------ */

/**
 * Place a cable's tag on one sheet: slide its mark along the wires (`along` = 0…1 of the run the
 * cable's wires share, or `at` = the coordinate along them), put the tag on a side of the mark,
 * and / or shift it by dx / dy from where it is; `reset` = automatic again.
 * Returns the tag's box afterwards (null when the cable has no wires on this sheet).
 */
export function placeCableTag(doc: Doc, page: Page, tag: string, o: { along?: number; at?: number; side?: Side; dx?: number; dy?: number; reset?: boolean; gap?: number }, styles: Styles, measure: Measure): { box: Rect; mark: { a: Pt; b: Pt }; horizontal: boolean; lo: number; hi: number } | null {
  const cable = (doc.cables ?? []).find((c) => c.tag === tag);
  if (!cable) return null;
  const mark = () => computeCableMarks(doc, page).find((m) => m.tag === tag) ?? null;
  const rect = () => {
    const m = mark();
    const r = m && cableLabelRect(m, styles, measure);
    return m && r ? { m, r } : null;
  };
  if (!mark()) return null;
  const marks = (cable.marks ??= {});
  if (o.reset) delete marks[page.id];
  const setLabel = (topLeft: Pt) => {
    const m = mark()!;
    const cx = (m.a.x + m.b.x) / 2, cy = (m.a.y + m.b.y) / 2;
    marks[page.id] = { ...(marks[page.id] ?? {}), label: { x: round(topLeft.x - cx), y: round(topLeft.y - cy) } };
  };
  if (o.along !== undefined || o.at !== undefined) {
    const m = mark()!;
    const at = o.at ?? m.lo + (m.hi - m.lo) * Math.min(1, Math.max(0, o.along!));
    // the tag keeps its place next to the mark (its offset is from the mark)
    marks[page.id] = { ...(marks[page.id] ?? {}), at: Math.round(Math.min(Math.max(at, m.lo), m.hi)) };
  }
  if (o.side) {
    const cur = rect()!;
    const { m, r } = cur;
    const gap = o.gap ?? 2;
    const top = Math.min(m.a.y, m.b.y), bottom = Math.max(m.a.y, m.b.y), left = Math.min(m.a.x, m.b.x), right = Math.max(m.a.x, m.b.x);
    const cx = (m.a.x + m.b.x) / 2, cy = (m.a.y + m.b.y) / 2;
    setLabel(
      o.side === "above" ? { x: cx - r.w / 2, y: top - gap - r.h }
      : o.side === "below" ? { x: cx - r.w / 2, y: bottom + gap }
      : o.side === "left" ? { x: left - gap - r.w, y: cy - r.h / 2 }
      : { x: right + gap, y: cy - r.h / 2 },
    );
  }
  if (o.dx || o.dy) {
    const { r } = rect()!;
    setLabel({ x: r.x + (o.dx ?? 0), y: r.y + (o.dy ?? 0) });
  }
  if (marks[page.id] && !Object.keys(marks[page.id]).length) delete marks[page.id];
  if (!Object.keys(marks).length) delete cable.marks;
  const after = rect();
  return after ? { box: after.r, mark: { a: after.m.a, b: after.m.b }, horizontal: after.m.horizontal, lo: after.m.lo, hi: after.m.hi } : null;
}
