import { describe, expect, it } from "vitest";
import { produce } from "immer";
import type { Doc, Shape } from "../model";
import { newDoc } from "../doc";
import { mkSel, mirrorSelection, rotateSelection } from "../ops";
import { arrowGeometry, connectorBetween, formGeometry, shapeDistance, shapeEdgeDistance, shapeTextBox } from "../shape-geom";
import { boxPresetOf, boxShape, pathShape, setBoxPreset, shapeName } from "../shape-presets";
import { pageToSvg, approxMeasure } from "../render/svg";
import { exportQet, importQet } from "../qet";
import { exportPdf } from "../render/pdf";
import { pageToDxf } from "../render/dxf";

const look = { color: "#111827", width: 1, dash: "solid" as const, fill: null };
const doc1 = (...shapes: Shape[]): Doc => {
  const d = newDoc("t");
  d.pages[0].shapes.push(...shapes);
  return d;
};

describe("block-diagram shapes", () => {
  it("draws presets as rectangles with a form, radius or text, and names them", () => {
    const tb = boxShape("a", "textbox", { x: 100, y: 60 }, { x: 20, y: 20 }, look);
    expect(tb).toMatchObject({ kind: "rect", pts: [{ x: 20, y: 20 }, { x: 100, y: 60 }], label: { text: "" } });
    expect(shapeName(tb)).toBe("Text box");
    expect(shapeName(boxShape("b", "rounded", { x: 0, y: 0 }, { x: 40, y: 20 }, look))).toBe("Rounded box");
    expect(shapeName(boxShape("c", "diamond", { x: 0, y: 0 }, { x: 40, y: 20 }, look))).toBe("Diamond");
    expect(shapeName(pathShape("d", "arrow", [{ x: 0, y: 0 }, { x: 50, y: 0 }], look))).toBe("Arrow");
    const bent = pathShape("e", "arrow", [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }], look);
    expect(bent).toMatchObject({ kind: "polygon", closed: false, arrows: { end: true }, fill: null });
    expect(shapeName(bent)).toBe("Bent arrow");
    // switching outline keeps the box and the text
    const s = boxShape("f", "rect", { x: 0, y: 0 }, { x: 40, y: 20 }, look);
    s.label = { text: "PSU" };
    setBoxPreset(s, "cylinder");
    expect(s).toMatchObject({ kind: "rect", form: "cylinder", label: { text: "PSU" } });
    expect(boxPresetOf(s)).toBe("cylinder");
    setBoxPreset(s, "ellipse");
    expect(s.kind).toBe("ellipse");
    expect(s.form).toBeUndefined();
  });

  it("puts the text where it fits: inside a diamond, the bottom half of a triangle, below a cylinder's top", () => {
    const d = boxShape("a", "diamond", { x: 0, y: 0 }, { x: 80, y: 40 }, look);
    expect(formGeometry(d)!.outline).toEqual([{ x: 40, y: 0 }, { x: 80, y: 20 }, { x: 40, y: 40 }, { x: 0, y: 20 }]);
    expect(shapeTextBox(d)).toEqual({ x: 20, y: 10, w: 40, h: 20 });
    const t = boxShape("b", "triangle", { x: 0, y: 0 }, { x: 80, y: 40 }, look);
    expect(shapeTextBox(t)).toEqual({ x: 20, y: 20, w: 40, h: 20 });
    const c = boxShape("c", "cylinder", { x: 0, y: 0 }, { x: 60, y: 100 }, look);
    const tb = shapeTextBox(c)!;
    expect(tb.y).toBeGreaterThan(0);
    expect(tb.y + tb.h).toBeLessThan(100);
    expect(formGeometry(c)!.rims).toHaveLength(1);
    const r = boxShape("d", "rect", { x: 0, y: 0 }, { x: 60, y: 30 }, look);
    expect(shapeTextBox(r)).toEqual({ x: 0, y: 0, w: 60, h: 30 });
    expect(shapeTextBox(pathShape("e", "line", [{ x: 0, y: 0 }, { x: 10, y: 0 }], look))).toBeNull();
  });

  it("turns and flips a form with its box", () => {
    const d = doc1(boxShape("tri", "triangle", { x: 0, y: 0 }, { x: 40, y: 20 }, look));
    const turned = produce(d, (x) => void rotateSelection(x, x.pages[0], mkSel({ shapes: ["tri"] })));
    const s = turned.pages[0].shapes[0];
    expect(s.turn).toBe(1);
    // pointing right now: the apex is the rightmost point, halfway down
    const o = formGeometry(s)!.outline;
    const apex = o[0];
    const b = { x: Math.min(...o.map((p) => p.x)), X: Math.max(...o.map((p) => p.x)), y: Math.min(...o.map((p) => p.y)), Y: Math.max(...o.map((p) => p.y)) };
    expect(apex.x).toBeCloseTo(b.X);
    expect(apex.y).toBeCloseTo((b.y + b.Y) / 2);
    const mirrored = produce(turned, (x) => void mirrorSelection(x, x.pages[0], mkSel({ shapes: ["tri"] })));
    const m = mirrored.pages[0].shapes[0];
    expect([m.turn, m.flip]).toEqual([3, true]);
    // now it points left
    const o2 = formGeometry(m)!.outline;
    expect(o2[0].x).toBeCloseTo(Math.min(...o2.map((p) => p.x)));
    // four turns back to where it started
    const back = produce(d, (x) => {
      for (let i = 0; i < 4; i++) rotateSelection(x, x.pages[0], mkSel({ shapes: ["tri"] }));
    });
    expect(back.pages[0].shapes[0].turn).toBeUndefined();
  });

  it("a box with text in it is hit inside; its edge is still the edge", () => {
    const s = boxShape("a", "rect", { x: 0, y: 0 }, { x: 100, y: 50 }, look);
    expect(shapeDistance(s, { x: 50, y: 25 })).toBeGreaterThan(20);
    s.label = { text: "Controller" };
    expect(shapeDistance(s, { x: 50, y: 25 })).toBe(0);
    expect(shapeEdgeDistance(s, { x: 50, y: 25 })).toBe(25);
    const dia = boxShape("b", "diamond", { x: 0, y: 0 }, { x: 100, y: 50 }, look);
    dia.label = { text: "OK?" };
    expect(shapeDistance(dia, { x: 50, y: 25 })).toBe(0);
    expect(shapeDistance(dia, { x: 3, y: 3 })).toBeGreaterThan(0); // outside the diamond, inside its box
  });

  it("puts arrow heads at the ends and stops the line inside them", () => {
    const a = pathShape("a", "arrow", [{ x: 0, y: 0 }, { x: 100, y: 0 }], { ...look, width: 2 });
    const g = arrowGeometry(a);
    expect(g.heads).toHaveLength(1);
    expect(g.heads[0][0]).toEqual({ x: 100, y: 0 });
    expect(g.path[1].x).toBeLessThan(100);
    expect(g.path[0]).toEqual({ x: 0, y: 0 });
    a.arrows = { start: true, end: true };
    expect(arrowGeometry(a).heads).toHaveLength(2);
  });

  it("connects two boxes side to side: straight when they overlap, one bend otherwise", () => {
    const A = boxShape("a", "rect", { x: 0, y: 0 }, { x: 100, y: 60 }, look);
    const B = boxShape("b", "rect", { x: 200, y: 20 }, { x: 300, y: 80 }, look);
    expect(connectorBetween(A, B)).toEqual([{ x: 100, y: 40 }, { x: 200, y: 40 }]);
    const C = boxShape("c", "rect", { x: 200, y: 200 }, { x: 300, y: 260 }, look);
    // further down than across: leaves at the bottom, enters at the top
    const p = connectorBetween(A, C);
    expect(p[0]).toEqual({ x: 50, y: 60 });
    expect(p[p.length - 1]).toEqual({ x: 250, y: 200 });
    expect(p).toHaveLength(4);
    const below = boxShape("d", "rect", { x: 20, y: 150 }, { x: 120, y: 200 }, look);
    expect(connectorBetween(A, below)).toEqual([{ x: 60, y: 60 }, { x: 60, y: 150 }]);
  });

  it("renders the text wrapped inside the box, and a line's label on the line", () => {
    const box = boxShape("a", "rounded", { x: 0, y: 0 }, { x: 80, y: 60 }, look);
    box.label = { text: "Main power distribution board", bold: true };
    const arrow = pathShape("b", "arrow", [{ x: 80, y: 30 }, { x: 200, y: 30 }], look);
    arrow.label = { text: "24 V DC" };
    const svg = pageToSvg(doc1(box, arrow), doc1(box, arrow).pages[0], { measure: approxMeasure, decor: false });
    // wrapped at 80 units: several text pieces, all inside the box
    const words = [...svg.matchAll(/<text[^>]*x="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), t: m[2] }));
    const inBox = words.filter((w) => /Main|power|distribution|board/.test(w.t));
    expect(inBox.length).toBeGreaterThan(1); // wrapped onto lines…
    expect(inBox.map((w) => w.t).join(" ")).toBe("Main power distribution board"); // …each line one text, words spaced
    expect(inBox.every((w) => w.x >= 0 && w.x < 80)).toBe(true);
    expect(words.some((w) => w.t === "24 V DC")).toBe(true);
    expect(svg).toContain('font-weight="700"');
  });

  it("exports to DXF (outline, rounded corners, text as one entity per line) and PDF", async () => {
    const box = boxShape("a", "rounded", { x: 100, y: 100 }, { x: 260, y: 180 }, { ...look, fill: "#e0f2fe" });
    box.label = { text: "**Battery pack**\n48 V · 30 Ah" };
    const d = doc1(box, pathShape("b", "arrow", [{ x: 260, y: 140 }, { x: 400, y: 140 }], look));
    // the PDF first: its own text measuring must not leak into the DXF layout
    const pdf = await exportPdf(d, { pages: d.pages });
    expect(pdf.length).toBeGreaterThan(1000);
    const dxf = pageToDxf(d, d.pages[0]);
    const texts = dxf.split("\n").filter((_, i, a) => a[i - 1] === "1");
    expect(texts).toContain("Battery pack");
    expect(texts).toContain("48 V · 30 Ah");
    // the rounded box is one closed polyline with more than 4 corners
    expect(dxf.match(/POLYLINE/g)!.length).toBeGreaterThan(1);
  });

  it("goes out to QElectroTech: forms as polygons, text as free texts, rounded corners as rx", () => {
    const d = doc1(
      Object.assign(boxShape("a", "diamond", { x: 100, y: 100 }, { x: 180, y: 140 }, look), { label: { text: "Ready?" } }),
      boxShape("b", "rounded", { x: 300, y: 100 }, { x: 380, y: 140 }, look),
    );
    const xml = exportQet(d).xml;
    expect(xml).toMatch(/<shape[^>]*type="Polygon"/);
    expect(xml).toMatch(/<shape[^>]*type="Rectangle"[^>]*rx="8"/);
    expect(xml).toMatch(/<input[^>]*text="Ready\?"/);
    const back = importQet(xml, "t.qet").doc;
    expect(back.pages[0].shapes.find((s) => s.kind === "rect")?.radius).toBe(8);
    expect(back.pages[0].texts.some((t) => t.text === "Ready?")).toBe(true);
  });
});
