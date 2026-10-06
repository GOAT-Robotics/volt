import { describe, expect, it } from "vitest";
import { ampacity, checkElectrical, conflict, netlistText, potentialOfLabel, projectNets, ratedCurrent, requiredPe, type ErcFinding } from "../erc";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import type { Doc, ElemInst, ElementDef, Page, Wire } from "../model";
import { mkDef, mkDoc, twoPin } from "./helpers";

const codes = (f: ErcFinding[]) => f.map((x) => x.code);

function wire(doc: Doc, page: Page, a: ElemInst, pa: string, b: ElemInst, pb: string, extra: Partial<Wire> = {}) {
  const da = doc.defs[a.defId], db = doc.defs[b.defId];
  const p1 = toScene(a, da.pins.find((p) => p.id === pa)!), p2 = toScene(b, db.pins.find((p) => p.id === pb)!);
  return addWire(page, { k: "pin", el: a.id, pin: pa, p: p1 }, { k: "pin", el: b.id, pin: pb, p: p2 }, [p1, { x: p1.x, y: p2.y }, p2], extra)!;
}

function relays(n: number, def: ElementDef = twoPin("relay", { name: "relay coil" })) {
  const { doc, page } = mkDoc();
  const els = Array.from({ length: n }, (_, i) => {
    const e = newElement(doc, page, def, { x: 105 + i * 100, y: 105 + (i % 2) * 200 });
    e.info.label = `K${i + 1}`;
    return e;
  });
  return { doc, page, els };
}

describe("potentials", () => {
  it("reads rail names", () => {
    expect(potentialOfLabel("L1")?.kind).toBe("L1");
    expect(potentialOfLabel("+24V")).toMatchObject({ kind: "DC+", volts: 24 });
    expect(potentialOfLabel("24VDC")).toMatchObject({ kind: "DC+", volts: 24 });
    expect(potentialOfLabel("0V")?.kind).toBe("DC0");
    expect(potentialOfLabel("230VAC")).toMatchObject({ kind: "L", volts: 230 });
    expect(potentialOfLabel("PE")?.kind).toBe("PE");
    expect(potentialOfLabel("101")).toBeNull();
  });
  it("knows what is a short", () => {
    const P = (s: string) => potentialOfLabel(s)!;
    expect(conflict(P("L1"), P("L2"))).toMatch(/phase-to-phase/);
    expect(conflict(P("L1"), P("N"))).toMatch(/neutral/);
    expect(conflict(P("PE"), P("L3"))).toMatch(/protective earth/);
    expect(conflict(P("+24V"), P("0V"))).toMatch(/DC supply/);
    expect(conflict(P("+24V"), P("+12V"))).toMatch(/different voltages/);
    expect(conflict(P("PE"), P("0V"))).toBeNull(); // PELV
    expect(conflict(P("L"), P("L2"))).toBeNull();
  });
  it("sizes conductors", () => {
    expect(ampacity(1.5)).toBeLessThan(16);
    expect(ampacity(2.5)).toBeGreaterThanOrEqual(16);
    expect(requiredPe(10)).toBe(10);
    expect(requiredPe(25)).toBe(16);
    expect(requiredPe(95)).toBe(47.5);
    expect(ratedCurrent({ info: { rating: "C16" } } as unknown as ElemInst)).toBe(16);
    expect(ratedCurrent({ info: { rating: "10 A gG" } } as unknown as ElemInst)).toBe(10);
  });
});

describe("checkElectrical", () => {
  it("a clean circuit has no errors", () => {
    const { doc, page, els } = relays(2);
    wire(doc, page, els[0], "2", els[1], "1", { label: "101" });
    expect(checkElectrical(doc).filter((f) => f.level === "error")).toEqual([]);
  });

  it("phase-to-neutral short through one conductor", () => {
    const { doc, page, els } = relays(3);
    wire(doc, page, els[0], "2", els[1], "1", { label: "L1", fn: "L1" });
    wire(doc, page, els[1], "1", els[2], "1", { label: "N", fn: "N" });
    const f = checkElectrical(doc).filter((x) => x.code === "erc.short");
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/neutral/);
    expect(f[0].anchor?.type).toBe("wire");
  });

  it("PE joined to a live conductor is a safety error", () => {
    const { doc, page, els } = relays(3);
    wire(doc, page, els[0], "2", els[1], "1", { fn: "PE" });
    wire(doc, page, els[1], "1", els[2], "1", { label: "+24V" });
    expect(codes(checkElectrical(doc))).toContain("erc.peLive");
  });

  it("label and function that disagree on one wire", () => {
    const { doc, page, els } = relays(2);
    wire(doc, page, els[0], "2", els[1], "1", { label: "N", fn: "L1" });
    const c = codes(checkElectrical(doc));
    expect(c).toContain("erc.markingMismatch");
    expect(c).not.toContain("erc.short");
  });

  it("component with both terminals on one conductor (bypassed)", () => {
    const { doc, page, els } = relays(2);
    wire(doc, page, els[0], "1", els[1], "1");
    wire(doc, page, els[0], "2", els[1], "1");
    const f = checkElectrical(doc).filter((x) => x.code === "erc.selfShort");
    expect(f.map((x) => x.ids[0])).toContain(els[0].id);
    expect(f.find((x) => x.ids[0] === els[0].id)?.level).toBe("error"); // a coil
  });

  it("reversed DC polarity at a device", () => {
    const psuDef = mkDef("dev", [
      { id: "p", x: 0, y: -20, orient: "n", number: "1", name: "+" },
      { id: "m", x: 0, y: 20, orient: "s", number: "2", name: "-" },
    ], { name: "sensor", prefix: "B" });
    const { doc, page } = mkDoc();
    const b = newElement(doc, page, psuDef, { x: 105, y: 105 });
    b.info.label = "B1";
    const k = newElement(doc, page, twoPin("relay"), { x: 305, y: 105 });
    k.info.label = "K1";
    wire(doc, page, b, "p", k, "1", { label: "0V" });
    expect(codes(checkElectrical(doc))).toContain("erc.polarity");
  });

  it("unconnected PE terminal of a motor", () => {
    const motor = mkDef("motor", [
      { id: "u", x: -10, y: -20, orient: "n", number: "U" },
      { id: "pe", x: 10, y: -20, orient: "n", number: "PE", name: "PE" },
    ], { name: "Motor 3~", prefix: "M" });
    const { doc, page } = mkDoc();
    const m = newElement(doc, page, motor, { x: 105, y: 205 });
    m.info.label = "M1";
    const q = newElement(doc, page, twoPin("contactor"), { x: 105, y: 55 });
    q.info.label = "K1";
    wire(doc, page, q, "2", m, "u", { fn: "L1", section: "1.5 mm²" });
    const f = checkElectrical(doc).find((x) => x.code === "erc.peOpen");
    expect(f?.level).toBe("error");
    expect(codes(checkElectrical(doc))).toContain("erc.motorOverload");
  });

  it("protective device larger than its conductors allow", () => {
    const fuse = twoPin("fuse", { name: "circuit breaker 1P", prefix: "F" });
    const { doc, page } = mkDoc();
    const f = newElement(doc, page, fuse, { x: 105, y: 105 });
    f.info.label = "F1";
    f.info.rating = "C16";
    const k = newElement(doc, page, twoPin("relay"), { x: 305, y: 305 });
    k.info.label = "K1";
    wire(doc, page, f, "2", k, "1", { section: "1.5 mm²", label: "L1", fn: "L1" });
    const x = checkElectrical(doc).find((i) => i.code === "erc.overcurrent");
    expect(x?.message).toMatch(/16 A/);
    expect(x?.suggestion).toMatch(/2\.5 mm²/);
  });

  it("section reduced inside one conductor", () => {
    const { doc, page, els } = relays(3);
    wire(doc, page, els[0], "2", els[1], "1", { section: "2.5" });
    wire(doc, page, els[1], "1", els[2], "1", { section: "1.5" });
    expect(codes(checkElectrical(doc))).toContain("erc.sectionStep");
  });

  it("naming: wrong letter code, two numbers on one conductor, one number on two conductors", () => {
    const { doc, page, els } = relays(4);
    els[0].info.label = "Q1"; // relay class expects K
    wire(doc, page, els[0], "2", els[1], "1", { label: "101" });
    wire(doc, page, els[1], "1", els[2], "1", { label: "102" });
    wire(doc, page, els[2], "2", els[3], "1", { label: "101" });
    const c = codes(checkElectrical(doc));
    expect(c).toContain("erc.prefix");
    expect(c).toContain("erc.multiNumber");
    expect(c).toContain("erc.numberReuse"); // info level
  });

  it("emergency stop on normally-open contacts", () => {
    const es = mkDef("estop", [
      { id: "13", x: 0, y: -20, orient: "n", number: "13" },
      { id: "14", x: 0, y: 20, orient: "s", number: "14" },
    ], { name: "Emergency stop push button", prefix: "S" });
    const { doc, page } = mkDoc();
    const s = newElement(doc, page, es, { x: 105, y: 105 });
    s.info.label = "S1";
    const k1 = newElement(doc, page, twoPin("relay"), { x: 305, y: 105 });
    const k2 = newElement(doc, page, twoPin("relay"), { x: 305, y: 305 });
    wire(doc, page, s, "13", k1, "1");
    wire(doc, page, s, "14", k2, "1");
    expect(codes(checkElectrical(doc))).toContain("erc.estopNO");
  });

  it("folio reports join conductors across pages", () => {
    const rep = mkDef("rep", [{ id: "1", x: 0, y: 0, orient: "e" }], { linkType: "next_report", prefix: "" });
    const { doc, page, els } = relays(1);
    const r1 = newElement(doc, page, rep, { x: 405, y: 105 });
    const page2: Page = { ...structuredClone(page), id: "p2", elements: [], wires: [], junctions: [], texts: [], shapes: [], order: 2 };
    doc.pages.push(page2);
    const r2 = newElement(doc, page2, rep, { x: 105, y: 105 });
    const k2 = newElement(doc, page2, twoPin("relay"), { x: 305, y: 105 });
    r1.links = [r2.id];
    r2.links = [r1.id];
    wire(doc, page, els[0], "2", r1, "1", { label: "L1" });
    wire(doc, page2, r2, "1", k2, "1", { label: "N" });
    const { nets } = projectNets(doc);
    expect(nets.some((n) => n.wires.length === 2)).toBe(true);
    expect(codes(checkElectrical(doc))).toContain("erc.short");
    r1.links = [];
    expect(codes(checkElectrical(doc))).toContain("erc.reportOpen");
  });

  it("netlist text has keys for anchoring", () => {
    const { doc, page, els } = relays(2);
    wire(doc, page, els[0], "2", els[1], "1", { label: "101", section: "1.5 mm²" });
    const n = netlistText(doc);
    expect(n.text).toMatch(/E1 \| P1 \| K1/);
    expect(n.text).toMatch(/W1=101/);
    expect(n.keys.elements.get(els[0].id)).toBe("E1");
  });
});
