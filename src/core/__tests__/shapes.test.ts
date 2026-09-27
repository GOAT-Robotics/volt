import { describe, it, expect } from "vitest";
import type { Doc, Page, Shape } from "../model";
import { newDoc } from "../doc";
import { copySelection, deleteSelection, mkSel, moveSelection, newElement, pasteClip, rotateSelection } from "../ops";
import { convertShapesToWires, isOpenPath, shapeDistance } from "../shapes";
import { computeNets } from "../topology";
import { exportQet, importQet, validateQet } from "../qet/project";
import { elementBounds } from "../render/scene";
import { mkDef, readFixtureQet } from "./helpers";

const line = (id: string, x1: number, y1: number, x2: number, y2: number, o: Partial<Shape> = {}): Shape => ({
  id,
  kind: "line",
  pts: [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ],
  color: "#000000",
  width: 1,
  dash: "solid",
  fill: null,
  ...o,
});

function setup(): { doc: Doc; page: Page } {
  const doc = newDoc("t");
  doc.numbering.autoOnPlace = false;
  return { doc, page: doc.pages[0] };
}

describe("drawing shapes", () => {
  it("hit distance: outline for open shapes, inside for filled ones", () => {
    const l = line("l", 0, 0, 100, 0);
    expect(shapeDistance(l, { x: 50, y: 3 })).toBeCloseTo(3);
    const r: Shape = { ...line("r", 0, 0, 100, 50), kind: "rect" };
    expect(shapeDistance(r, { x: 50, y: 25 })).toBeCloseTo(25); // hollow: distance to nearest edge
    expect(shapeDistance({ ...r, fill: "#ff0000" }, { x: 50, y: 25 })).toBe(0);
    const open: Shape = { ...line("p", 0, 0, 100, 0), kind: "polygon", closed: false, pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] };
    expect(isOpenPath(open)).toBe(true);
    expect(shapeDistance(open, { x: 50, y: 50 })).toBeCloseTo(50); // no closing edge
    expect(shapeDistance({ ...open, closed: true }, { x: 50, y: 50 })).toBeLessThan(1); // on the diagonal closing edge
  });

  it("move, rotate, delete, copy and paste include shapes", () => {
    const { doc, page } = setup();
    page.shapes.push(line("a", 0, 0, 40, 0), line("b", 0, 10, 40, 10));
    moveSelection(doc, page, mkSel({ shapes: ["a"] }), { x: 10, y: 5 });
    expect(page.shapes[0].pts).toEqual([
      { x: 10, y: 5 },
      { x: 50, y: 5 },
    ]);
    rotateSelection(doc, page, mkSel({ shapes: ["b"] }), true);
    const b = page.shapes[1];
    expect(b.pts[0].x).toBeCloseTo(b.pts[1].x); // horizontal → vertical
    const clip = copySelection(doc, page, mkSel({ shapes: ["a"] }));
    const sel = pasteClip(doc, page, clip, { x: 0, y: 100 });
    expect(sel.shapes).toHaveLength(1);
    expect(page.shapes).toHaveLength(3);
    expect(page.shapes[2].pts[0]).toEqual({ x: 10, y: 105 });
    deleteSelection(doc, page, mkSel({ shapes: ["a", sel.shapes[0]] }));
    expect(page.shapes.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("convert lines to wires", () => {
  const def = mkDef("box", [
    { id: "t", x: 0, y: -20, orient: "n" },
    { id: "b", x: 0, y: 20, orient: "s" },
  ]);

  it("connects line ends to nearby pins, merges corners and makes T junctions", () => {
    const { doc, page } = setup();
    const k1 = newElement(doc, page, def, { x: 105, y: 105 }); // pins at (105,85) and (105,125)
    const k2 = newElement(doc, page, def, { x: 305, y: 105 }); // pins at (305,85) and (305,125)
    // K1 top → up → across → down to K2 top, drawn as three lines slightly off the pins
    page.shapes.push(
      line("l1", 106, 87, 105.6, 45), // lands 2 units from the pin, nearly vertical
      line("l2", 105.6, 45, 305, 45.4),
      line("l3", 305, 45.4, 304, 86),
      // a branch from the middle of l2 down to nothing
      line("l4", 205, 45, 205, 20),
      // a closed rectangle is not converted
      { ...line("r", 0, 0, 10, 10), kind: "rect" },
    );
    const r = convertShapesToWires(doc, page, ["l1", "l2", "l3", "l4", "r"]);
    expect(r.converted).toBe(4);
    expect(r.skipped).toBe(1);
    expect(page.shapes.map((s) => s.id)).toEqual(["r"]);
    const nets = computeNets(page);
    const net = nets.find((n) => n.pins.some((p) => p.el === k1.id && p.pin === "t"))!;
    expect(net.pins.some((p) => p.el === k2.id && p.pin === "t")).toBe(true);
    // the branch hangs off a junction on the top run
    expect(page.junctions).toHaveLength(1);
    expect(page.junctions[0]).toMatchObject({ x: 205 });
    // ends snapped exactly onto the pins, runs straightened
    for (const w of page.wires) for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], b = w.pts[i];
      expect(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9).toBe(true);
    }
    const toK1 = page.wires.find((w) => [w.a, w.b].some((e) => e.k === "pin" && e.el === k1.id))!;
    const p = toK1.a.k === "pin" ? toK1.pts[0] : toK1.pts[toK1.pts.length - 1];
    expect(p).toEqual({ x: 105, y: 85 });
  });

  it("keeps a non-default colour / line style as a wire override", () => {
    const { doc, page } = setup();
    page.shapes.push(line("l", 0, 0, 100, 0, { color: "#0000ff", dash: "dashed" }));
    convertShapesToWires(doc, page, ["l"]);
    expect(page.wires[0].override).toEqual({ color: "#0000ff", dash: "dashed" });
  });
});

describe("element hit box", () => {
  it("covers pins and strokes drawn outside the saved frame", () => {
    const { doc, page } = setup();
    const def = mkDef("wide", [{ id: "far", x: 40, y: 0, orient: "e" }]); // frame is x −10..10
    const e = newElement(doc, page, def, { x: 0, y: 0 });
    const r = elementBounds(e, def);
    expect(r.x + r.w).toBeGreaterThanOrEqual(40);
  });
});

describe("shapes in project files", () => {
  it("imports open polylines as open, and writes edits back", () => {
    const { doc, page } = setup();
    page.shapes.push({ ...line("p", 0, 0, 0, 0), kind: "polygon", closed: false, pts: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 40 }], color: "#ff0000", width: 2, dash: "dashed" });
    page.shapes.push({ ...line("r", 100, 100, 150, 130), kind: "rect", fill: "#00ff00" });
    const xml = exportQet(doc).xml;
    expect(validateQet(xml)).toEqual([]);
    const back = importQet(xml, "t.qet").doc.pages[0].shapes;
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ kind: "polygon", closed: false, color: "#ff0000", width: 2, dash: "dashed", pts: page.shapes[0].pts });
    expect(back[1]).toMatchObject({ kind: "rect", fill: "#00ff00", pts: page.shapes[1].pts });
  });

  it("untouched projects still export byte-identical", () => {
    for (const f of ["2612_ats_singlephase.qet"]) {
      const src = readFixtureQet(f);
      expect(exportQet(importQet(src, f).doc).xml).toBe(src);
    }
  });
});
