import { describe, it, expect } from "vitest";
import type { Wire } from "../model";
import { newDoc } from "../doc";
import { newElement, addWire } from "../ops";
import { assignCores, cableDesignation, cableMarks, colorLabel, colorOf, makeCores, sectionMm2, sectionWeight, standardColor, wireAnnotation, wireInfo } from "../wiring";
import { exportQet, importQet } from "../qet/project";
import { validateDoc } from "../validate";
import { mkDef } from "./helpers";

const wire = (id: string, y: number, o: Partial<Wire> = {}): Wire => ({ id, a: { k: "free" }, b: { k: "free" }, pts: [{ x: 0, y }, { x: 200, y }], ...o });

describe("colours and sizes", () => {
  it("understands common spellings and prints them per standard", () => {
    expect(colorOf("BK")?.name).toBe("Black");
    expect(colorOf("black")?.code).toBe("BK");
    expect(colorOf("BLK")?.code).toBe("BK");
    expect(colorOf("gn/ye")?.code).toBe("GNYE");
    expect(colorOf("purple-ish")).toBeNull();
    expect(colorLabel("GNYE", "iec")).toBe("GN/YE");
    expect(colorLabel("BK", "nfpa")).toBe("BLK");
    expect(colorLabel("custom", "iec")).toBe("custom");
  });

  it("standard colours per function", () => {
    expect(standardColor("acControl", "iec")).toBe("RD");
    expect(standardColor("dcControl", "nfpa")).toBe("BU");
    expect(standardColor("N", "nfpa")).toBe("WH");
    expect(standardColor("PE", "iec")).toBe("GNYE");
    expect(standardColor("interlock", "jis")).toBe("OG");
    expect(standardColor(undefined, "iec")).toBeUndefined();
  });

  it("reads cross-sections in any notation", () => {
    expect(sectionMm2("1.5 mm²")).toBe(1.5);
    expect(sectionMm2("1,5")).toBe(1.5);
    expect(sectionMm2("1.5 sqmm")).toBe(1.5);
    expect(sectionMm2("1.25sq")).toBe(1.25);
    expect(sectionMm2("16 AWG")).toBeCloseTo(1.31);
    expect(sectionMm2("AWG 2/0")).toBeCloseTo(67.4);
    expect(sectionMm2("thick")).toBeNull();
    expect(sectionWeight("0.5 mm²")).toBeLessThan(sectionWeight("16 mm²"));
  });
});

describe("conductor information", () => {
  it("colour: explicit > cable core > standard", () => {
    const doc = newDoc("t");
    doc.cables = [{ id: "c", tag: "W1", cores: makeCores(4, "colors", true), section: "1.5 mm²" }];
    expect(wireInfo(doc, wire("a", 0, { fn: "acControl" })).color).toBe("RD");
    expect(wireInfo(doc, wire("a", 0, { fn: "acControl", cable: "W1", core: "BN" }))).toMatchObject({ color: "BN", colorSource: "core", section: "1.5 mm²" });
    expect(wireInfo(doc, wire("a", 0, { fn: "acControl", insulation: "VT", cable: "W1", core: "BN" }))).toMatchObject({ color: "VT", colorSource: "wire" });
    expect(wireAnnotation(doc, wire("a", 0, { insulation: "BK", section: "1.5 mm²" }))).toBe("BK 1.5 mm²");
    doc.wiring = { standard: "nfpa", showColor: true, showSection: false, tick: true, colorize: false, weightBySection: false };
    expect(wireAnnotation(doc, wire("a", 0, { insulation: "BK", section: "16 AWG" }))).toBe("BLK");
  });

  it("cable cores: HD 308 colours, numbered cores, designation", () => {
    expect(makeCores(4, "colors", true).map((c) => c.name)).toEqual(["BN", "BK", "GY", "GNYE"]);
    expect(makeCores(5, "colors", false).map((c) => c.name)).toEqual(["BN", "BK", "GY", "BU", "BK2"]);
    expect(makeCores(4, "numbered", true).map((c) => c.name)).toEqual(["1", "2", "3", "GNYE"]);
    expect(cableDesignation({ cores: makeCores(4, "colors", true), section: "1.5 mm²" })).toBe("4G1.5");
    expect(cableDesignation({ cores: makeCores(3, "colors", false), section: "2.5" })).toBe("3x2.5");
  });

  it("assigns free cores in drawing order and keeps green-yellow for PE", () => {
    const doc = newDoc("t");
    const cable = { id: "c", tag: "W1", cores: makeCores(4, "colors", true) };
    doc.cables = [cable];
    const ws = [wire("pe", 40, { fn: "PE" }), wire("l1", 10), wire("l2", 20), wire("l3", 30)];
    doc.pages[0].wires.push(...ws);
    assignCores(doc, cable, ws);
    expect(ws.map((w) => w.core)).toEqual(["GNYE", "BN", "BK", "GY"]);
  });

  it("places one cable mark across the shared run of the cable's wires", () => {
    const doc = newDoc("t");
    doc.cables = [{ id: "c", tag: "W1", type: "ÖLFLEX 4G1.5", cores: makeCores(4, "colors", true), shield: true }];
    doc.pages[0].wires.push(wire("a", 10, { cable: "W1" }), wire("b", 20, { cable: "W1" }), { ...wire("c", 30, { cable: "W1" }), pts: [{ x: 50, y: 30 }, { x: 150, y: 30 }] }, wire("x", 100));
    const [m] = cableMarks(doc, doc.pages[0]);
    expect(m.wires.sort()).toEqual(["a", "b", "c"]);
    expect(m.horizontal).toBe(true);
    expect((m.a.x + m.b.x) / 2).toBeGreaterThanOrEqual(54);
    expect((m.a.x + m.b.x) / 2).toBeLessThanOrEqual(146);
    expect(m.a.y).toBeLessThan(10);
    expect(m.b.y).toBeGreaterThan(30);
    expect(m.label).toBe("W1 · ÖLFLEX 4G1.5");
    expect(m.shield).toBe(true);
  });
});

describe("project files and checks", () => {
  it("keeps colour, cross-section, function and core through export / import", () => {
    const doc = newDoc("t");
    doc.numbering.autoOnPlace = false;
    const page = doc.pages[0];
    const def = mkDef("box", [{ id: "t", x: 0, y: -20, orient: "n" }, { id: "b", x: 0, y: 20, orient: "s" }]);
    const k1 = newElement(doc, page, def, { x: 105, y: 105 });
    const k2 = newElement(doc, page, def, { x: 305, y: 105 });
    const w = addWire(page, { k: "pin", el: k1.id, pin: "t", p: { x: 105, y: 85 } }, { k: "pin", el: k2.id, pin: "t", p: { x: 305, y: 85 } }, [{ x: 105, y: 85 }, { x: 105, y: 45 }, { x: 305, y: 45 }, { x: 305, y: 85 }])!;
    Object.assign(w, { insulation: "BU", section: "0.75 mm²", fn: "dcControl", cable: "W3", core: "2" });
    const back = importQet(exportQet(doc).xml, "t.qet").doc.pages[0].wires[0];
    expect(back).toMatchObject({ insulation: "BU", section: "0.75 mm²", fn: "dcControl", cable: "W3", core: "2" });
  });

  it("flags green-yellow on non-PE wires and PE wires in another colour", () => {
    const doc = newDoc("t");
    doc.pages[0].wires.push(wire("a", 0, { fn: "acControl", insulation: "GNYE" }), wire("b", 20, { fn: "PE", insulation: "BK" }));
    const codes = validateDoc(doc).map((i) => i.code);
    expect(codes).toContain("wire.gnyeMisuse");
    expect(codes).toContain("wire.peColor");
  });
});

import { wireStroke, layoutElementTexts, docStyles } from "../render/scene";
import { symbolFor } from "../render/symbol";
import { approxMeasure } from "../render/svg";
import { endAddress, wireEndLabel } from "../wiring";

describe("drawing priorities and wire ends", () => {
  it("a conductor color wins over the appearance color; standard colors only when enabled", () => {
    const doc = newDoc("t");
    const st = docStyles(doc);
    expect(wireStroke(st, wire("a", 0, { insulation: "BU", override: { color: "#ff00ff" } }), undefined, doc).color).toBe(colorOf("BU")!.hex);
    expect(wireStroke(st, wire("a", 0, { override: { color: "#ff00ff" } }), undefined, doc).color).toBe("#ff00ff");
    expect(wireStroke(st, wire("a", 0, { fn: "acControl" }), undefined, doc).color).toBe(st.graphics.wire.color);
    doc.wiring = { standard: "iec", showColor: true, showSection: true, tick: true, colorize: true, weightBySection: false };
    expect(wireStroke(st, wire("a", 0, { fn: "acControl" }), undefined, doc).color).toBe(colorOf("RD")!.hex);
  });

  it("names each end: manual name, number at ends, far-end address", () => {
    const doc = newDoc("t");
    doc.numbering.autoOnPlace = false;
    const page = doc.pages[0];
    const def = mkDef("box", [{ id: "t", x: 0, y: -20, orient: "n", number: "1" }, { id: "b", x: 0, y: 20, orient: "s", number: "2" }]);
    const q1 = newElement(doc, page, def, { x: 105, y: 105 });
    const x1 = newElement(doc, page, def, { x: 105, y: 305 });
    q1.info.label = "Q1";
    x1.info.label = "X1";
    const w = addWire(page, { k: "pin", el: q1.id, pin: "b", p: { x: 105, y: 125 } }, { k: "pin", el: x1.id, pin: "t", p: { x: 105, y: 285 } }, [{ x: 105, y: 125 }, { x: 105, y: 285 }])!;
    w.label = "1A-01-0";
    expect(endAddress(doc, page, w.b)).toBe("X1:1");
    expect(wireEndLabel(doc, page, w, "a", false, false)).toBe("");
    expect(wireEndLabel(doc, page, w, "a", true, false)).toBe("1A-01-0");
    expect(wireEndLabel(doc, page, w, "a", true, true)).toBe("1A-01-0 / X1:1");
    expect(wireEndLabel(doc, page, w, "b", false, true)).toBe("Q1:2");
    w.endLabels = { b: "W7" };
    expect(wireEndLabel(doc, page, w, "b", true, true)).toBe("W7");
  });

  it("stacks name, rating and manufacturer / part number under the reference", () => {
    const doc = newDoc("t");
    doc.numbering.autoOnPlace = false;
    const def = mkDef("mcb", [{ id: "t", x: 0, y: -20, orient: "n" }]);
    const e = newElement(doc, doc.pages[0], def, { x: 105, y: 105 });
    Object.assign(e.info, { label: "Q1", description: "2-pole MCB", rating: "16 A", manufacturer: "Schneider", manufacturer_reference: "A9F74216" });
    const texts = () => layoutElementTexts(e, symbolFor(def), docStyles(doc), approxMeasure).map((t) => t.text);
    expect(texts()).toEqual(["Q1", "2-pole MCB", "16 A"]);
    e.showInfo = { manufacturer: true, manufacturer_reference: true, rating: false };
    expect(texts()).toEqual(["Q1", "2-pole MCB", "Schneider · A9F74216"]);
    const laid = layoutElementTexts(e, symbolFor(def), docStyles(doc), approxMeasure);
    expect(laid[1].y).toBeGreaterThan(laid[0].y);
    expect(laid[1].x).toBeCloseTo(laid[0].x);
  });
});
