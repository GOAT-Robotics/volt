import { describe, expect, it } from "vitest";
import type { Doc, ElemInst, Page, Rect } from "../model";
import { newElement, addWire, moveSelection, mkSel } from "../ops";
import { docStyles, elementBounds } from "../render/scene";
import { approxMeasure } from "../render/svg";
import { componentLabels, placeCableTag, placeLabels, INFO_BLOCK, XREF_LABEL } from "../label-place";
import { computeCableMarks } from "../wiring";
import { mkDef, mkDoc } from "./helpers";

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const box = (doc: Doc, page: Page, e: ElemInst, kind: string) => componentLabels(doc, page, e, docStyles(doc), approxMeasure).find((l) => l.kind === kind)?.box;

/** an off-page arrow named "RGB CONTROLLER" on page 1, linked to its counterpart on page 2; its name sits where the cross-reference goes by default */
function arrows() {
  const { doc, page } = mkDoc();
  const rep = mkDef("rep", [{ id: "1", x: 10, y: 0, orient: "e" }], { linkType: "next_report", prefix: "", width: 20, height: 10, hotspotX: 10, hotspotY: 5, prims: [{ t: "rect", x: -10, y: -5, w: 20, h: 10, rx: 0, ry: 0, style: { lineStyle: "normal", lineWeight: "normal", filling: "none", color: "black" } }] });
  const a = newElement(doc, page, rep, { x: 305, y: 205 });
  a.info.label = "RGB CONTROLLER";
  a.texts = [{ id: "ref", role: "componentRef", info: "label", text: "", x: -80, y: -9 }];
  const page2: Page = { ...structuredClone(page), id: "p2", elements: [], wires: [], junctions: [], texts: [], shapes: [], order: 2 };
  doc.pages.push(page2);
  const b = newElement(doc, page2, { ...rep, linkType: "previous_report" }, { x: 105, y: 305 });
  b.info.label = "RGB CONTROLLER";
  a.links = [b.id];
  b.links = [a.id];
  return { doc, page, a };
}

describe("component labels", () => {
  it("an off-page arrow's cross-reference goes past its name instead of over it", () => {
    const { doc, page, a } = arrows();
    const ref = box(doc, page, a, "reference")!, xref = box(doc, page, a, "xref")!;
    expect(ref).toBeTruthy();
    expect(xref).toBeTruthy();
    expect(overlap(ref, xref)).toBe(false);
    // still on the far side from the connection point, past the name
    expect(xref.x + xref.w).toBeLessThanOrEqual(ref.x);
  });

  it("moves the cross-reference by dx / dy; it follows the arrow afterwards", () => {
    const { doc, page, a } = arrows();
    const before = box(doc, page, a, "xref")!;
    placeLabels(doc, page, a, ["xref"], { dy: 20 }, docStyles(doc), approxMeasure);
    const after = box(doc, page, a, "xref")!;
    expect(after.y - before.y).toBeCloseTo(20, 0);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(a.xrefPos).toBeTruthy();
    moveSelection(doc, page, mkSel({ elements: [a.id] }), { x: 50, y: 0 });
    const moved = page.elements.find((e) => e.id === a.id)!;
    expect(box(doc, page, moved, "xref")!.x).toBeCloseTo(after.x + 50, 0);
  });

  it("stacks labels on a side of the symbol, and resets them", () => {
    const { doc, page, a } = arrows();
    const body = elementBounds(a, doc.defs[a.defId]);
    placeLabels(doc, page, a, ["reference", "xref"], { side: "below" }, docStyles(doc), approxMeasure);
    const ref = box(doc, page, a, "reference")!, xref = box(doc, page, a, "xref")!;
    expect(ref.y).toBeGreaterThanOrEqual(body.y + body.h);
    expect(xref.y).toBeGreaterThanOrEqual(ref.y + ref.h - 0.01);
    expect(overlap(ref, xref)).toBe(false);
    // centred under the arrow
    expect(ref.x + ref.w / 2).toBeCloseTo(body.x + body.w / 2, 0);
    placeLabels(doc, page, a, ["all" as never, "reference", "xref"], { reset: true }, docStyles(doc), approxMeasure);
    expect(a.xrefPos).toBeUndefined();
    expect(a.texts[0].x).toBeNull();
  });

  it("moves the description lines as one block, and a reference exactly by dx on a turned component", () => {
    const { doc, page } = mkDoc();
    const k = newElement(doc, page, mkDef("k", [{ id: "1", x: 0, y: -20, orient: "n" }]), { x: 200, y: 200 }, 1);
    k.info.label = "K1";
    k.info.description = "Main contactor";
    k.texts = [{ id: "r", role: "componentRef", info: "label", text: "", x: null, y: null }];
    const st = docStyles(doc);
    const labels = componentLabels(doc, page, k, st, approxMeasure);
    expect(labels.find((l) => l.id === INFO_BLOCK)).toBeTruthy();
    const body = elementBounds(k, doc.defs.k);
    placeLabels(doc, page, k, ["description"], { side: "above" }, st, approxMeasure);
    const d = box(doc, page, k, "description")!;
    expect(d.y + d.h).toBeLessThanOrEqual(body.y + 0.01);
    expect(k.infoLayout?.at).toBe("free");
    const r0 = box(doc, page, k, "reference")!;
    placeLabels(doc, page, k, ["reference"], { dx: 15, dy: -5 }, st, approxMeasure);
    const r1 = box(doc, page, k, "reference")!;
    expect(r1.x - r0.x).toBeCloseTo(15, 0);
    expect(r1.y - r0.y).toBeCloseTo(-5, 0);
    expect(labels.some((l) => l.id === XREF_LABEL)).toBe(false);
  });
});

describe("cable tags", () => {
  function cable() {
    const { doc, page } = mkDoc();
    const d = mkDef("t", [{ id: "1", x: 10, y: 0, orient: "e" }]);
    const e = mkDef("u", [{ id: "1", x: -10, y: 0, orient: "w" }]);
    doc.cables = [{ id: "c1", tag: "W1", cores: [] }];
    for (const y of [100, 120, 140]) {
      const a = newElement(doc, page, d, { x: 100, y }), b = newElement(doc, page, e, { x: 400, y });
      const w = addWire(page, { k: "pin", el: a.id, pin: "1", p: { x: 110, y } }, { k: "pin", el: b.id, pin: "1", p: { x: 390, y } }, [{ x: 110, y }, { x: 390, y }])!;
      w.cable = "W1";
    }
    return { doc, page };
  }
  it("slides the mark along the run, puts the tag on a side, shifts it, resets", () => {
    const { doc, page } = cable();
    const st = docStyles(doc);
    const m0 = computeCableMarks(doc, page)[0];
    const r = placeCableTag(doc, page, "W1", { along: 0 }, st, approxMeasure)!;
    expect((r.mark.a.x + r.mark.b.x) / 2).toBeCloseTo(m0.lo, 0);
    const below = placeCableTag(doc, page, "W1", { side: "below" }, st, approxMeasure)!;
    expect(below.box.y).toBeGreaterThan(Math.max(r.mark.a.y, r.mark.b.y));
    const shifted = placeCableTag(doc, page, "W1", { dx: 10, dy: 5 }, st, approxMeasure)!;
    expect(shifted.box.x - below.box.x).toBeCloseTo(10, 0);
    expect(shifted.box.y - below.box.y).toBeCloseTo(5, 0);
    // the tag keeps its place next to the mark when the mark slides
    const slid = placeCableTag(doc, page, "W1", { along: 1 }, st, approxMeasure)!;
    expect(slid.box.x - shifted.box.x).toBeCloseTo((slid.mark.a.x + slid.mark.b.x) / 2 - (r.mark.a.x + r.mark.b.x) / 2, 0);
    placeCableTag(doc, page, "W1", { reset: true }, st, approxMeasure);
    expect(doc.cables![0].marks).toBeUndefined();
  });
});
