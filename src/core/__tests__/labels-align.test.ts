import { describe, it, expect } from "vitest";
import type { Wire } from "../model";
import { newDoc } from "../doc";
import { docStyles, wireTexts } from "../render/scene";
import { SvgPainter } from "../render/svg";
import { symbolFor } from "../render/symbol";
import { mkDef } from "./helpers";

const sp = new SvgPainter();
const measure = sp.measure.bind(sp);

describe("pin numbers written as text in the symbol", () => {
  it("are flagged when they repeat a pin number next to the pin", () => {
    const def = mkDef("fuse", [
      { id: "1", x: 0, y: -20, orient: "n" },
      { id: "2", x: 0, y: 20, orient: "s" },
    ]);
    def.prims.push(
      { t: "text", x: 3, y: -14, text: "1", size: 9, rotation: 0, color: "black" },
      { t: "text", x: 3, y: 18, text: "2", size: 9, rotation: 90, color: "black" },
      { t: "text", x: -30, y: 0, text: "1", size: 9, rotation: 0, color: "black" }, // far from pin 1
      { t: "text", x: 3, y: 0, text: "F", size: 9, rotation: 0, color: "black" },
    );
    const flags = symbolFor(def).texts.map((t) => !!t.pinDup);
    expect(flags).toEqual([true, true, false, false]);
  });
});

describe("parallel wires", () => {
  it("put their numbers and conductor specs in one column", () => {
    const doc = newDoc("t");
    const page = doc.pages[0];
    const mk = (id: string, y: number, x0: number, label: string): Wire => ({
      id,
      a: { k: "free" },
      b: { k: "free" },
      pts: [{ x: x0, y }, { x: 600, y }],
      label,
      insulation: "BK",
      section: "1.5 mm²",
    });
    // different starts, like a fuse in one line and a plain terminal in the other
    page.wires = [mk("w1", 100, 160, "2A-00-1"), mk("w2", 120, 20, "1A-04-0")];
    doc.wiring = { standard: "iec", showColor: true, showSection: true, tick: true, colorize: false, weightBySection: false };
    const items = wireTexts(doc, page, docStyles(doc), measure, "test");
    const c = (id: string, spec: boolean) => {
      const it = items.get(id)!.find((x) => !!x.spec === spec)!;
      return it.x + it.w / 2;
    };
    expect(c("w1", false)).toBeCloseTo(c("w2", false), 5);
    expect(c("w1", true)).toBeCloseTo(c("w2", true), 5);
  });

  it("a wire far away keeps its own position", () => {
    const doc = newDoc("t");
    const page = doc.pages[0];
    page.wires = [
      { id: "a", a: { k: "free" }, b: { k: "free" }, pts: [{ x: 0, y: 100 }, { x: 400, y: 100 }], label: "1" },
      { id: "b", a: { k: "free" }, b: { k: "free" }, pts: [{ x: 200, y: 400 }, { x: 600, y: 400 }], label: "2" },
    ];
    const items = wireTexts(doc, page, docStyles(doc), measure, "test");
    const a = items.get("a")![0], b = items.get("b")![0];
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(100);
  });
});
