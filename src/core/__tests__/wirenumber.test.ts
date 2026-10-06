import { describe, expect, it } from "vitest";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import type { Doc, ElemInst, ElementDef, Page, Wire } from "../model";
import { mkDef, mkDoc, twoPin } from "./helpers";
import { applyWireNumbers, classifyNets, DEFAULT_CLASSES, formatWireLabel, parseWireLabel, planWireNumbers, PRESETS, segLetter, wireNumberingOf } from "../wirenumber";
import { checkElectrical, projectNets } from "../erc";

function wire(doc: Doc, page: Page, a: ElemInst, pa: string, b: ElemInst, pb: string, extra: Partial<Wire> = {}) {
  const da = doc.defs[a.defId], db = doc.defs[b.defId];
  const p1 = toScene(a, da.pins.find((p) => p.id === pa)!), p2 = toScene(b, db.pins.find((p) => p.id === pb)!);
  return addWire(page, { k: "pin", el: a.id, pin: pa, p: p1 }, { k: "pin", el: b.id, pin: pb, p: p2 }, [p1, { x: p1.x, y: p2.y }, p2], extra)!;
}

const psu = (v: number) =>
  mkDef(`psu${v}`, [
    { id: "p", x: 0, y: -20, orient: "n", number: "1", name: `+${v}V` },
    { id: "m", x: 0, y: 20, orient: "s", number: "2", name: "0V" },
  ], { name: `Power supply ${v} V`, prefix: "G" });
const fuse = twoPin("fuse", { name: "fuse", prefix: "F" });
const lamp = twoPin("lamp", { name: "pilot lamp", prefix: "P" });

/** +24V → F1 → K1 coil → 0V, and +48V → F2 → lamp → 0V */
function circuit() {
  const { doc, page } = mkDoc();
  const g24 = newElement(doc, page, psu(24), { x: 105, y: 305 });
  const f1 = newElement(doc, page, fuse, { x: 205, y: 105 });
  const k1 = newElement(doc, page, twoPin("relay", { name: "relay coil" }), { x: 305, y: 305 });
  const g48 = newElement(doc, page, psu(48), { x: 505, y: 305 });
  const f2 = newElement(doc, page, fuse, { x: 605, y: 105 });
  const h1 = newElement(doc, page, lamp, { x: 705, y: 305 });
  [g24, f1, k1, g48, f2, h1].forEach((e, i) => (e.info.label = ["G1", "F1", "K1", "G2", "F2", "H1"][i]));
  const w = [
    wire(doc, page, g24, "p", f1, "1"),
    wire(doc, page, f1, "2", k1, "1"),
    wire(doc, page, k1, "2", g24, "m"),
    wire(doc, page, g48, "p", f2, "1"),
    wire(doc, page, f2, "2", h1, "1"),
    wire(doc, page, h1, "2", g48, "m"),
  ];
  return { doc, page, w, els: { g24, f1, k1, g48, f2, h1 } };
}

describe("format", () => {
  const cfg = wireNumberingOf({});
  it("writes and reads identifiers", () => {
    expect(formatWireLabel(cfg, { cls: "B", n: 12, seg: "A", ret: false })).toBe("B012A");
    expect(formatWireLabel(cfg, { cls: "B", n: 13, seg: "B", ret: true })).toBe("B013BN");
    expect(parseWireLabel("B012A", cfg)).toMatchObject({ cls: "B", n: 12, seg: "A", ret: false });
    expect(parseWireLabel("PE001C", cfg)).toMatchObject({ cls: "PE", n: 1, seg: "C" });
    expect(parseWireLabel("+24V", cfg)).toBeNull();
    expect(segLetter(0)).toBe("A");
    expect(segLetter(7)).toBe("H");
    expect(segLetter(8)).toBe("J"); // no I
    expect(segLetter(22)).toBe("Z");
    expect(segLetter(23)).toBe("AA");
  });
  it("panel preset numbers by sheet and column", () => {
    const p = { ...PRESETS.panel, classes: DEFAULT_CLASSES };
    expect(formatWireLabel(p, { cls: "B", seg: "", ret: false, page: 3, col: 12 })).toBe("B3.12");
    expect(parseWireLabel("B3.12.2", p)).toMatchObject({ cls: "B", page: 3, col: 12, dup: 2 });
  });
});

describe("classification", () => {
  it("detects voltage systems from supply pins and propagates through fuses and loads", () => {
    const { doc, w } = circuit();
    const { nets, netOfWire } = projectNets(doc);
    const cls = classifyNets(doc);
    const letter = (i: number) => cls.get(netOfWire.get(w[i].id)!.id)!.letter;
    expect(letter(0)).toBe("B");
    expect(letter(1)).toBe("B"); // after the fuse
    expect(letter(2)).toBe("B"); // 0 V return of the 24 V system
    expect(cls.get(netOfWire.get(w[2].id)!.id)!.isReturn).toBe(true);
    expect(letter(3)).toBe("A");
    expect(letter(4)).toBe("A");
    expect(nets.length).toBe(6);
  });
  it("an explicit class on a wire wins", () => {
    const { doc, w } = circuit();
    w[4].vclass = "5v";
    const cls = classifyNets(doc);
    expect(cls.get(projectNets(doc).netOfWire.get(w[4].id)!.id)!.letter).toBe("C");
  });
});

describe("planWireNumbers", () => {
  it("numbers every circuit with class, number, segment and return suffix", () => {
    const { doc, w } = circuit();
    const plan = planWireNumbers(doc, { mode: "all" });
    applyWireNumbers(doc, plan);
    // reading order: sheet → column → top to bottom (the 0 V return starts left of the fuse output)
    expect(w.map((x) => x.label)).toEqual(["B001A", "B003A", "B002AN", "A001A", "A003A", "A002AN"]);
  });

  it("keeps existing numbers and gives new conductors the next free number", () => {
    const { doc, page, w, els } = circuit();
    applyWireNumbers(doc, planWireNumbers(doc, { mode: "all" }));
    // a second lamp in parallel with K1 → new segment on the existing circuits
    const h2 = newElement(doc, page, lamp, { x: 405, y: 505 });
    const extra = wire(doc, page, els.f1, "2", h2, "1");
    const plan = planWireNumbers(doc, { mode: "new" });
    expect(plan.changes.map((c) => [c.from, c.to])).toEqual([["", "B003B"]]);
    applyWireNumbers(doc, plan);
    expect(extra.label).toBe("B003B");
    expect(w[0].label).toBe("B001A");
  });

  it("never touches locked numbers and keeps rail names when asked", () => {
    const { doc, w } = circuit();
    w[0].label = "MAIN-24";
    w[0].labelLocked = true;
    w[2].label = "0V";
    doc.wireNumbering = { ...wireNumberingOf(doc), replacePotentialNames: false };
    const plan = planWireNumbers(doc, { mode: "all" });
    expect(plan.changes.find((c) => c.wireId === w[0].id)).toBeUndefined();
    expect(plan.changes.find((c) => c.wireId === w[2].id)).toBeUndefined();
    expect(plan.stats.locked).toBe(1);
  });

  it("replacing a rail name keeps its meaning as the conductor function", () => {
    const { doc, w } = circuit();
    w[2].label = "0V";
    applyWireNumbers(doc, planWireNumbers(doc, { mode: "all" }));
    expect(w[2].label).toBe("B002AN");
    expect(w[2].fn).toBe("dc0V");
    // and the next run still knows it is a 24 V return
    expect(planWireNumbers(doc, { mode: "new" }).changes).toEqual([]);
  });

  it("segments of one circuit are not reported as conflicting numbers by the rule check", () => {
    const { doc, page, els } = circuit();
    const h2 = newElement(doc, page, lamp, { x: 405, y: 505 });
    wire(doc, page, els.f1, "2", h2, "1");
    doc.wireNumbering = wireNumberingOf(doc);
    applyWireNumbers(doc, planWireNumbers(doc, { mode: "all" }));
    expect(checkElectrical(doc).map((f) => f.code)).not.toContain("erc.multiNumber");
  });

  it("renumber all closes gaps", () => {
    const { doc, page, w } = circuit();
    applyWireNumbers(doc, planWireNumbers(doc, { mode: "all" }));
    page.wires = page.wires.filter((x) => x.id !== w[0].id); // B001 disappears
    const plan = planWireNumbers(doc, { mode: "all" });
    applyWireNumbers(doc, plan);
    expect(w[2].label).toBe("B001AN");
    expect(w[1].label).toBe("B002A");
  });
});

void ({} as ElementDef);
