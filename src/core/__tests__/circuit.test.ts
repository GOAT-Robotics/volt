import { describe, expect, it } from "vitest";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import type { Doc, ElemInst, Page, PinClass } from "../model";
import { circuitOf } from "../circuit";
import { checkElectrical } from "../erc";
import { inferSig, sigConflict } from "../signals";
import { functionFor, legacyCircuit, standardColor, standardColorFor, wireInfo } from "../wiring";
import { mkDef, mkDoc } from "./helpers";

function wire(page: Page, doc: Doc, a: ElemInst, pa: string, b: ElemInst, pb: string) {
  const p1 = toScene(a, doc.defs[a.defId].pins.find((p) => p.id === pa)!), p2 = toScene(b, doc.defs[b.defId].pins.find((p) => p.id === pb)!);
  return addWire(page, { k: "pin", el: a.id, pin: pa, p: p1 }, { k: "pin", el: b.id, pin: pb, p: p2 }, [p1, { x: p1.x, y: p2.y }, p2])!;
}
const dev = (id: string, name: string, cls?: PinClass, volts?: number) => {
  const d = mkDef(id, [{ id: "p", x: 0, y: 20, orient: "s", number: "1", name }], { name: id });
  d.pins[0].cls = cls;
  d.pins[0].volts = volts;
  return d;
};

describe("potential + use replace the old function", () => {
  it("every legacy function keeps its standard colour", () => {
    for (const std of ["iec", "nfpa", "jis"] as const)
      for (const fn of ["power", "L1", "L2", "L3", "N", "PE", "acControl", "dcControl", "dc0V", "interlock", "signal"] as const) {
        const { pot, use } = legacyCircuit(fn);
        expect([fn, std, standardColorFor(pot, use, std)]).toEqual([fn, std, standardColor(fn, std)]);
        expect(functionFor(pot, use)).toBe(fn);
      }
  });

  it("a wire with an old function still reads as potential + use", () => {
    const { doc } = mkDoc();
    const w = { id: "w", a: { k: "free" as const }, b: { k: "free" as const }, pts: [], fn: "dc0V" as const };
    expect(wireInfo(doc, w).color).toBe("BU");
    expect(wireInfo(doc, { ...w, fn: undefined, pot: "DC0", use: "control" }).color).toBe("BU");
  });
});

describe("circuit detection", () => {
  it("0 V of a 24 V supply: supply B, potential 0 V, return, control → blue", () => {
    const { doc, page } = mkDoc();
    const psu = newElement(doc, page, dev("psu", "-V", "DC0", 24), { x: 100, y: 100 });
    psu.info.rating = "24 V DC";
    const load = newElement(doc, page, dev("load", "1"), { x: 300, y: 100 });
    const w = wire(page, doc, psu, "p", load, "p");
    const c = circuitOf(doc, w.id)!;
    expect(c).toMatchObject({ letter: "B", pot: "DC0", use: "control", isReturn: true, color: "BU" });
    expect(c.supply?.id).toBe("24v");
  });

  it("an explicit potential / use on the wire wins", () => {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, dev("a", "L1", "L1"), { x: 100, y: 100 });
    const b = newElement(doc, page, dev("b", "1"), { x: 300, y: 100 });
    const w = wire(page, doc, a, "p", b, "p");
    expect(circuitOf(doc, w.id)).toMatchObject({ pot: "L1", use: "power", color: "BN" });
    w.use = "control";
    expect(circuitOf({ ...doc }, w.id)).toMatchObject({ pot: "L1", use: "control", color: "RD", useSet: true });
  });
});

describe("signal buses", () => {
  it("recognises bus pins by name", () => {
    expect(inferSig("CAN_H")).toEqual({ bus: "CAN", line: "H" });
    expect(inferSig("TXD")).toEqual({ bus: "RS232", line: "TXD" });
    expect(inferSig("TX")).toEqual({ bus: "UART", line: "TX" });
    expect(inferSig("RS485_A")).toEqual({ bus: "RS485", line: "A" });
    expect(inferSig("SDA")).toEqual({ bus: "I2C", line: "SDA" });
    expect(inferSig("I0.3")).toEqual({ bus: "DIO", line: "IN" });
    expect(inferSig("A1")).toBeNull();
  });
  it("line to line on buses, TX → RX on point-to-point serial", () => {
    expect(sigConflict({ bus: "CAN", line: "H" }, { bus: "CAN", line: "H" })).toBeNull();
    expect(sigConflict({ bus: "CAN", line: "H" }, { bus: "CAN", line: "L" })).toMatch(/CAN H is wired to L/);
    expect(sigConflict({ bus: "UART", line: "TX" }, { bus: "UART", line: "RX" })).toBeNull();
    expect(sigConflict({ bus: "UART", line: "TX" }, { bus: "UART", line: "TX" })).toMatch(/expected RX/);
    expect(sigConflict({ bus: "CAN", line: "H" }, { bus: "RS485", line: "B" })).toMatch(/CAN H is wired to RS-485 B/);
    expect(sigConflict({ bus: "DIO", line: "OUT" }, { bus: "DIO", line: "OUT" })).toBeTruthy();
  });
  it("ERC flags CAN H wired to CAN L, accepts H to H", () => {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, dev("a", "CAN_H"), { x: 100, y: 100 });
    const b = newElement(doc, page, dev("b", "CAN_L"), { x: 300, y: 100 });
    const c = newElement(doc, page, dev("c", "CAN_H"), { x: 500, y: 100 });
    wire(page, doc, a, "p", b, "p");
    expect(checkElectrical(doc).find((f) => f.code === "erc.busMismatch")?.level).toBe("error");
    page.wires = [];
    const w = wire(page, doc, a, "p", c, "p");
    expect(checkElectrical(doc).some((f) => f.code === "erc.busMismatch")).toBe(false);
    expect(circuitOf(doc, w.id)).toMatchObject({ pot: "signal", sigs: [{ bus: "CAN", line: "H" }] });
  });
});
