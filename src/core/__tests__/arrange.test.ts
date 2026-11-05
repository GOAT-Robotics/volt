import { describe, expect, it } from "vitest";
import { alignItems, arrangeCount, arrangeItems, centreOn, distributeItems, referenceItem } from "../arrange";
import { emptySel, newElement } from "../ops";
import { docStyles } from "../render/scene";
import { approxMeasure } from "../render/svg";
import type { FreeText, Rect } from "../model";
import { mkDef, mkDoc } from "./helpers";

const text = (id: string, x: number, y: number, s: string): FreeText => ({ id, x, y, text: s, role: "annotation" });

function setup() {
  const { doc, page } = mkDoc();
  const def = mkDef("box", [{ id: "1", x: 0, y: -20, orient: "n" }]);
  doc.defs[def.id] = def;
  const a = newElement(doc, page, def, { x: 100, y: 100 });
  const b = newElement(doc, page, def, { x: 230, y: 160 });
  page.texts.push(text("t1", 40, 300, "Connector"), text("t2", 95, 340, "DC to DC Convertor"), text("t3", 60, 420, "Inverter"));
  return { doc, page, a, b, styles: docStyles(doc) };
}
const boxes = (r: { box: Rect }[]) => r.map((i) => i.box);

describe("align & distribute", () => {
  it("aligns texts of different widths on their left, right and centre", () => {
    const { doc, page, styles } = setup();
    const sel = { ...emptySel(), texts: ["t1", "t2", "t3"] };
    alignItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "left");
    expect(new Set(boxes(arrangeItems(doc, page, sel, styles, approxMeasure)).map((b) => b.x)).size).toBe(1);
    alignItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "right");
    expect(new Set(boxes(arrangeItems(doc, page, sel, styles, approxMeasure)).map((b) => (b.x + b.w).toFixed(2))).size).toBe(1);
    alignItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "center");
    expect(new Set(boxes(arrangeItems(doc, page, sel, styles, approxMeasure)).map((b) => (b.x + b.w / 2).toFixed(1))).size).toBe(1);
  });

  it("moves components only in whole grid steps, mixed with texts", () => {
    const { doc, page, a, b, styles } = setup();
    const sel = { ...emptySel(), elements: [a.id, b.id], texts: ["t1"] };
    expect(arrangeCount(page, sel)).toBe(3);
    alignItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "top");
    for (const e of [a, b]) expect(e.x % 10 === 0 && e.y % 10 === 0).toBe(true);
    expect(a.y).toBe(b.y);
  });

  it("leaves locked components alone", () => {
    const { doc, page, a, b, styles } = setup();
    b.locked = true;
    const sel = { ...emptySel(), elements: [a.id, b.id], texts: ["t1"] };
    expect(arrangeCount(page, sel)).toBe(2);
    const y = b.y;
    alignItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "bottom");
    expect(b.y).toBe(y);
  });

  it("spaces items with equal gaps, or a fixed gap", () => {
    const { doc, page, styles } = setup();
    const sel = { ...emptySel(), texts: ["t1", "t2", "t3"] };
    distributeItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "y");
    let bs = boxes(arrangeItems(doc, page, sel, styles, approxMeasure)).sort((p, q) => p.y - q.y);
    expect(bs[1].y - (bs[0].y + bs[0].h)).toBeCloseTo(bs[2].y - (bs[1].y + bs[1].h), 1);
    distributeItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "y", 20);
    bs = boxes(arrangeItems(doc, page, sel, styles, approxMeasure)).sort((p, q) => p.y - q.y);
    expect(bs[1].y - (bs[0].y + bs[0].h)).toBeCloseTo(20, 1);
    expect(bs[2].y - (bs[1].y + bs[1].h)).toBeCloseTo(20, 1);
  });

  it("aligns to a component, which stays put, and centres texts on it both ways", () => {
    const { doc, page, a, styles } = setup();
    const sel = { ...emptySel(), elements: [a.id], texts: ["t1", "t2"] };
    const ref = referenceItem(doc, page, sel)!;
    const before = { x: a.x, y: a.y };
    centreOn(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), ref);
    expect({ x: a.x, y: a.y }).toEqual(before);
    for (const b of boxes(arrangeItems(doc, page, { ...emptySel(), texts: ["t1", "t2"] }, styles, approxMeasure))) {
      expect(b.x + b.w / 2).toBeCloseTo(ref.box.x + ref.box.w / 2, 1);
      expect(b.y + b.h / 2).toBeCloseTo(ref.box.y + ref.box.h / 2, 1);
    }
  });

  it("uses a locked component as the anchor", () => {
    const { doc, page, a, styles } = setup();
    a.locked = true;
    const sel = { ...emptySel(), elements: [a.id], texts: ["t3"] };
    const ref = referenceItem(doc, page, sel)!;
    alignItems(doc, page, arrangeItems(doc, page, sel, styles, approxMeasure), "left", ref);
    expect(arrangeItems(doc, page, { ...emptySel(), texts: ["t3"] }, styles, approxMeasure)[0].box.x).toBeCloseTo(ref.box.x, 2);
  });
});
