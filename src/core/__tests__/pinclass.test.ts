import { describe, expect, it } from "vitest";
import { checkElectrical, type ErcFinding } from "../erc";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import type { Doc, ElemInst, Page, PinClass } from "../model";
import { inferPinClass, pinClassOf, pinPotential } from "../pinclass";
import { parseElmt, serializeElmt } from "../qet";
import { classifyNets, wireNumberingOf, DEFAULT_CLASSES, PRESETS } from "../wirenumber";
import { mkDef, mkDoc } from "./helpers";

const codes = (f: ErcFinding[]) => f.map((x) => x.code);

function wire(page: Page, doc: Doc, a: ElemInst, pa: string, b: ElemInst, pb: string) {
  const p1 = toScene(a, doc.defs[a.defId].pins.find((p) => p.id === pa)!), p2 = toScene(b, doc.defs[b.defId].pins.find((p) => p.id === pb)!);
  return addWire(page, { k: "pin", el: a.id, pin: pa, p: p1 }, { k: "pin", el: b.id, pin: pb, p: p2 }, [p1, { x: p1.x, y: p2.y }, p2])!;
}

/** one-pin device whose pin has the given name / class */
const dev = (id: string, name: string, cls?: PinClass, volts?: number) => {
  const d = mkDef(id, [{ id: "p", x: 0, y: 20, orient: "s", number: "1", name }], { name: id });
  d.pins[0].cls = cls;
  d.pins[0].volts = volts;
  return d;
};

describe("pin classes", () => {
  it("infers only unambiguous names", () => {
    expect(inferPinClass("L")).toBe("L");
    expect(inferPinClass("N")).toBe("N");
    expect(inferPinClass("FG")).toBe("PE");
    expect(inferPinClass("+V")).toBe("DC+");
    expect(inferPinClass("-V")).toBe("DC0");
    expect(inferPinClass("CAN_H")).toBe("signal");
    expect(inferPinClass("A1")).toBeNull();
    expect(inferPinClass("13")).toBeNull();
  });

  it("an explicit class wins; none silences the name", () => {
    expect(pinClassOf({ name: "1", number: "1", cls: "L" })).toBe("L");
    expect(pinClassOf({ name: "N", number: "2", cls: "none" })).toBeNull();
    expect(pinPotential({ name: "4", number: "4", cls: "DC+", volts: 24 })).toMatchObject({ kind: "DC+", volts: 24 });
  });

  it("round-trips through .elmt", () => {
    const d = dev("psu", "4", "DC+", 24);
    const back = parseElmt(serializeElmt(d), { id: "x" });
    expect(back.pins[0]).toMatchObject({ cls: "DC+", volts: 24 });
  });

  it("ERC: L wired to N is an error", () => {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, dev("a", "1", "L"), { x: 100, y: 100 });
    const b = newElement(doc, page, dev("b", "2", "N"), { x: 300, y: 100 });
    wire(page, doc, a, "p", b, "p");
    const f = checkElectrical(doc).find((x) => x.code === "erc.pinClass");
    expect(f?.level).toBe("error");
  });

  it("ERC: 24 V + to 12 V + is flagged, 24 V + to 24 V + is not", () => {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, dev("a", "+V", "DC+", 24), { x: 100, y: 100 });
    const b = newElement(doc, page, dev("b", "+V", "DC+", 12), { x: 300, y: 100 });
    const c = newElement(doc, page, dev("c", "+V", "DC+", 24), { x: 500, y: 100 });
    wire(page, doc, a, "p", b, "p");
    expect(codes(checkElectrical(doc))).toContain("erc.pinClass");
    page.wires = [];
    wire(page, doc, a, "p", c, "p");
    expect(codes(checkElectrical(doc))).not.toContain("erc.pinClass");
  });

  it("ERC: power on a signal pin is a warning", () => {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, dev("a", "+V", "DC+"), { x: 100, y: 100 });
    const b = newElement(doc, page, dev("b", "CAN_H"), { x: 300, y: 100 });
    wire(page, doc, a, "p", b, "p");
    expect(checkElectrical(doc).find((x) => x.code === "erc.pinSignal")?.level).toBe("warning");
  });

  it("wire numbering takes the circuit class from the pin class and volts", () => {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, dev("a", "4", "DC+", 24), { x: 100, y: 100 });
    const b = newElement(doc, page, dev("b", "1"), { x: 300, y: 100 });
    const w = wire(page, doc, a, "p", b, "p");
    const cls = [...classifyNets(doc).values()].find((c) => c.classId);
    expect(cls?.classId).toBe("24v");
    expect(w).toBeTruthy();
  });
});

describe("AC class letter", () => {
  it("defaults to AC, never X", () => {
    expect(DEFAULT_CLASSES.find((c) => c.id === "ac")?.letter).toBe("AC");
  });
  it("migrates projects saved with the old X", () => {
    const old = { ...PRESETS.harness, classes: DEFAULT_CLASSES.map((c) => (c.id === "ac" ? { ...c, letter: "X" } : c)) };
    const cfg = wireNumberingOf({ wireNumbering: old });
    expect(cfg.classes.find((c) => c.id === "ac")?.letter).toBe("AC");
    expect(wireNumberingOf({ wireNumbering: old })).toBe(cfg); // stable object (parser cache)
  });
});
