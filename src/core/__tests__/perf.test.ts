import { describe, expect, it } from "vitest";
import type { Doc, Page, Wire } from "../model";
import type { Painter } from "../render/painter";
import { drawPage } from "../render/scene";
import { addWire, deleteSelection, emptySel, moveSelection, refreshAttached, rotateSelection } from "../ops";
import { toScene } from "../geometry";
import { computeNets } from "../topology";
import { validateDoc } from "../validate";
import { fixtureDef, mkDoc } from "./helpers";

/* ------------------------------------------------------------------ */
/* Performance smoke                                                    */
/* ------------------------------------------------------------------ */

class NoopPainter implements Painter {
  readonly kind = "canvas" as const;
  n = 0;
  save() {}
  restore() {}
  transform() {}
  stroke() {
    this.n++;
  }
  fill() {
    this.n++;
  }
  text() {
    this.n++;
  }
  measure(t: string, s: number) {
    return t.length * s * 0.5;
  }
  scale() {
    return 1;
  }
}


function bigDoc(): { doc: Doc; page: Page } {
  const { doc, page } = mkDoc();
  const def = fixtureDef("contattiausiliari.elmt");
  doc.defs[def.id] = def;
  expect(def.pins.length).toBeGreaterThanOrEqual(2);
  const cols = 100;
  for (let i = 0; i < 5000; i++) {
    page.elements.push({ id: `e${i}`, defId: def.id, x: 105 + (i % cols) * 80, y: 105 + Math.floor(i / cols) * 120, rot: 0, mirror: false, info: { label: `K${i + 1}` }, texts: [{ id: `t${i}`, role: "componentRef", info: "label", text: "", x: null, y: null }] });
  }
  for (let k = 0; k < 8000; k++) {
    const a = page.elements[k % 5000], b = page.elements[(k * 7 + 1) % 5000];
    const pa = def.pins[k % def.pins.length], pb = def.pins[(k + 1) % def.pins.length];
    const A = toScene(a, pa), B = toScene(b, pb);
    page.wires.push({ id: `w${k}`, a: { k: "pin", el: a.id, pin: pa.id }, b: { k: "pin", el: b.id, pin: pb.id }, pts: [A, { x: A.x, y: B.y }, B] });
  }
  return { doc, page };
}
const time = (f: () => void) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe("performance smoke (5,000 elements / 8,000 wires)", () => {
  it("moveSelection of 200 elements + refreshAttached stays fast", () => {
    const { doc, page } = bigDoc();
    const ids = page.elements.slice(1000, 1200).map((e) => e.id);
    const sel = { ...emptySel(), elements: ids };
    moveSelection(doc, page, sel, { x: 10, y: 10 }); // warm-up
    const ms = time(() => {
      moveSelection(doc, page, sel, { x: 20, y: -10 });
      refreshAttached(doc, page, new Set(ids));
    });
    expect(ms).toBeLessThan(150);
    const rot = time(() => rotateSelection(doc, page, sel, true));
    expect(rot).toBeLessThan(150);
  });

  it("drawPage with a no-op painter stays fast", () => {
    const { doc, page } = bigDoc();
    const p = new NoopPainter();
    drawPage(p, { doc, page, lod: 1 }); // warm-up (symbol compile)
    const ms = time(() => drawPage(new NoopPainter(), { doc, page, lod: 1 }));
    expect(p.n).toBeGreaterThan(5000);
    expect(ms).toBeLessThan(400);
  });

  it("computeNets and validateDoc scale linearly", () => {
    const { doc, page } = bigDoc();
    expect(time(() => computeNets(page))).toBeLessThan(150);
    expect(time(() => validateDoc(doc))).toBeLessThan(1500);
  });
});

describe("performance smoke: junction-heavy page", () => {
  /** 2,000 T-junctions: each joins two elements' pins and a third element's pin (6,000 wires). */
  function teeDoc() {
    const { doc, page } = bigDoc();
    page.wires = [];
    const els = page.elements;
    const def = doc.defs[els[0].defId];
    for (let k = 0; k < 2000; k++) {
      const j = { id: `j${k}`, x: 0, y: 0 };
      const a = els[k], b = els[k + 2000], c = els[(k % 1000) + 4000];
      const pa = toScene(a, def.pins[0]);
      j.x = pa.x;
      j.y = pa.y + 20;
      page.junctions.push(j);
      for (const [e, pin] of [[a, def.pins[0]], [b, def.pins[1]], [c, def.pins[0]]] as const) {
        const p = toScene(e, pin);
        const w: Wire = { id: `w${k}-${e.id}`, a: { k: "pin", el: e.id, pin: pin.id }, b: { k: "junction", j: j.id }, pts: [p, { x: p.x, y: j.y }, { x: j.x, y: j.y }] };
        page.wires.push(w);
      }
    }
    return { doc, page };
  }
  it("deleting 200 elements and adding a wire stay fast", () => {
    const { doc, page } = teeDoc();
    const ids = page.elements.slice(4000, 4200).map((e) => e.id);
    const del = time(() => deleteSelection(doc, page, { ...emptySel(), elements: ids }));
    expect(del).toBeLessThan(250);
    const e = page.elements[10];
    const def = doc.defs[e.defId];
    const p = toScene(e, def.pins[1]);
    const add = time(() => addWire(page, { k: "pin", el: e.id, pin: def.pins[1].id, p }, { k: "free", p: { x: p.x + 30, y: p.y } }, [p, { x: p.x + 30, y: p.y }]));
    expect(add).toBeLessThan(50);
  });
});
