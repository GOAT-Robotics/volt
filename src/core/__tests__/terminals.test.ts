import { describe, expect, it } from "vitest";
import type { Doc, ElemInst, ElementDef, Page, Wire } from "../model";
import { collectStrips, isTerminalDef, parseTerminalRef, renumberStrip, setOrder, setRow, setStrip, setTerminalNumber, addSpare, moveToStrip, terminalPlanRows } from "../terminals";
import { buildBom } from "../bom";

const pin = (id: string, x: number, y: number, orient: "n" | "s", number = "") => ({ id, x, y, orient, name: "", number, type: "Generic" });
const terminal: ElementDef = {
  id: "term", uuid: "term", name: "borne", names: { en: "Terminal block" }, width: 10, height: 20, hotspotX: 5, hotspotY: 10, linkType: "terminal", prefix: "X", category: "",
  prims: [], pins: [pin("t1", 0, -10, "n"), pin("t2", 0, 10, "s")], info: {}, kind: { function: "generic" }, meta: {},
};
const mcb: ElementDef = { ...terminal, id: "mcb", uuid: "mcb", name: "mcb", names: { en: "MCB" }, linkType: "simple", pins: [pin("m1", 0, -10, "n", "1"), pin("m2", 0, 10, "s", "2")] };
const splice: ElementDef = { ...terminal, id: "splice", uuid: "splice", name: "splice", names: { en: "Splice" } };

let n = 0;
const el = (defId: string, label: string, x = 0, y = 0): ElemInst => ({ id: `e${n++}`, defId, x, y, rot: 0, mirror: false, info: { label }, texts: [] });
const wire = (a: [string, string], b: [string, string], extra: Partial<Wire> = {}): Wire => ({ id: `w${n++}`, a: { k: "pin", el: a[0], pin: a[1] }, b: { k: "pin", el: b[0], pin: b[1] }, pts: [{ x: 0, y: 0 }, { x: 0, y: 10 }], ...extra });

function project() {
  const page = (id: string, order: number): Page => ({ id, title: id, order, elements: [], wires: [], junctions: [], texts: [], shapes: [], meta: {} } as unknown as Page);
  const p1 = page("p1", 0), p2 = page("p2", 1);
  const q1 = el("mcb", "Q1");
  const x3 = el("term", "X1:3", 10), x1 = el("term", "X1:1", 20), xu = el("term", "X1", 30), y1 = el("term", "X2-01", 40);
  p1.elements.push(q1, x3, x1, xu, y1);
  p1.wires.push(wire([q1.id, "m2"], [x1.id, "t1"], { label: "101", cable: undefined }));
  const x1b = el("term", "X1:1", 0); // same terminal shown on sheet 2
  p2.elements.push(x1b);
  const doc = { pages: [p1, p2], defs: { term: terminal, mcb, splice }, wiring: undefined, cables: [] } as unknown as Doc;
  return { doc, ids: { q1: q1.id, x1: x1.id, x3: x3.id, xu: xu.id, y1: y1.id } };
}

describe("terminal strips", () => {
  it("recognises terminals and parses references", () => {
    expect(isTerminalDef(terminal)).toBe(true);
    expect(isTerminalDef(splice)).toBe(false);
    expect(isTerminalDef(mcb)).toBe(false);
    expect(parseTerminalRef("X1:3")).toEqual({ tag: "X1", num: "3", sep: ":" });
    expect(parseTerminalRef("-X1:PE")).toMatchObject({ tag: "-X1", num: "PE" });
    expect(parseTerminalRef("X2-01")).toMatchObject({ tag: "X2", num: "01", sep: "-" });
    expect(parseTerminalRef("=A1+B2-X1:3")).toMatchObject({ tag: "=A1+B2-X1", num: "3" });
    expect(parseTerminalRef("X1")).toMatchObject({ tag: "X1", num: null });
  });

  it("groups by strip, merges instances and lists connections per side", () => {
    const { doc, ids } = project();
    const v = collectStrips(doc);
    expect(v.map((x) => x.tag)).toEqual(["X1", "X2"]);
    const x1 = v[0];
    expect(x1.rows.map((r) => r.num)).toEqual(["1", "3", null]);
    const t1 = x1.rows[0];
    expect(t1.instances.map((i) => i.sheet)).toEqual([1, 2]);
    expect(t1.side1).toEqual(["Q1:2 (101)"]);
    expect(t1.side2).toEqual([]);
    expect(x1.rows[2].key).toBe(`@${ids.xu}`);
    expect(v[1].sep).toBe("-");
  });

  it("reorders, renumbers into references and keeps row data", () => {
    const { doc, ids } = project();
    const keys = collectStrips(doc)[0].rows.map((r) => r.key); // 1, 3, @xu
    setRow(doc, "X1", "3", { type: "pe", bridge: true });
    setOrder(doc, "X1", ["3", "1", `@${ids.xu}`]);
    expect(collectStrips(doc)[0].rows.map((r) => r.num)).toEqual(["3", "1", null]);
    renumberStrip(doc, "X1", ["3", "1", `@${ids.xu}`], { start: 1, pad: 2 });
    const labels = Object.fromEntries(doc.pages.flatMap((p) => p.elements).map((e) => [e.id, e.info.label]));
    expect(labels[ids.x3]).toBe("X1:01");
    expect(labels[ids.x1]).toBe("X1:02");
    expect(labels[ids.xu]).toBe("X1:03");
    const rows = collectStrips(doc)[0].rows;
    expect(rows.map((r) => r.num)).toEqual(["01", "02", "03"]);
    expect(rows[0].type).toBe("pe");
    expect(rows[0].row?.bridge).toBe(true);
    expect(rows[1].instances).toHaveLength(2); // both sheets renumbered
    expect(keys).toHaveLength(3);
  });

  it("renames a terminal, the strip and its separator", () => {
    const { doc, ids } = project();
    setTerminalNumber(doc, "X1", `@${ids.xu}`, "7");
    setStrip(doc, "X1", { tag: "X10", sep: "." });
    const labels = doc.pages.flatMap((p) => p.elements).map((e) => e.info.label);
    expect(labels).toContain("X10.7");
    expect(labels).toContain("X10.1");
    expect(labels).not.toContain("X1:3");
  });

  it("spares, moving between strips, plan and BOM", () => {
    const { doc, ids } = project();
    doc.terminalStrips = [];
    setStrip(doc, "X1", { partNumber: "3031212", manufacturer: "Phoenix Contact" });
    const spare = addSpare(doc, "X1");
    expect(spare).toBe("4");
    expect(collectStrips(doc)[0].rows.find((r) => r.spare)).toMatchObject({ spare: true, num: "4", key: "spare:4" });
    const moved = moveToStrip(doc, "X1", `@${ids.xu}`, "X2");
    expect(moved).toBe("2");
    expect(doc.pages[0].elements.find((e) => e.id === ids.xu)!.info.label).toBe("X2-2");
    const plan = terminalPlanRows(doc, ["X1"]);
    expect(plan[0]).toEqual(expect.arrayContaining(["X1", "1", "Q1:2 (101)", "3031212", "1, 2"]));
    const bom = buildBom(doc);
    const t = bom.rows.find((r) => r.partNumber === "3031212")!;
    expect(t.refs).toEqual(["X1:1", "X1:3", "X1:4"]); // spare X1:4 counted
    expect(t.manufacturer).toBe("Phoenix Contact");
  });
});

describe("terminal connections through folio reports", () => {
  const going: ElementDef = { ...terminal, id: "go", uuid: "go", name: "report_going", names: { en: "Folio report (going)" }, linkType: "next_report", prefix: "", pins: [pin("r", 0, 0, "n")] };
  const coming: ElementDef = { ...going, id: "come", uuid: "come", name: "report_coming", names: { en: "Folio report (coming)" }, linkType: "previous_report" };
  const coil: ElementDef = { ...mcb, id: "coil", uuid: "coil", name: "coil", names: { en: "Coil" }, pins: [pin("a1", 0, -10, "n", "A1"), pin("a2", 0, 10, "s", "A2")] };
  const page = (id: string, order: number): Page => ({ id, title: id, order, elements: [], wires: [], junctions: [], texts: [], shapes: [], meta: {} } as unknown as Page);
  const link = (a: ElemInst, b: ElemInst) => ((a.links = [...(a.links ?? []), b.id]), (b.links = [...(b.links ?? []), a.id]));

  function folioProject() {
    const p1 = page("p1", 0), p2 = page("p2", 1), p3 = page("p3", 2);
    const x1 = el("term", "X1:1"), g = el("go", "24V");
    const c2 = el("come", "24V"), k1 = el("coil", "K1");
    p1.elements.push(x1, g);
    p1.wires.push(wire([x1.id, "t2"], [g.id, "r"])); // no wire number on this sheet
    p2.elements.push(c2, k1);
    p2.wires.push(wire([c2.id, "r"], [k1.id, "a1"], { label: "201" }));
    link(g, c2);
    const doc = { pages: [p1, p2, p3], defs: { term: terminal, mcb, go: going, come: coming, coil }, wiring: undefined, cables: [] } as unknown as Doc;
    return { doc, p1, p2, p3, x1, g, c2, k1 };
  }
  const side2 = (doc: Doc) => collectStrips(doc).find((v) => v.tag === "X1")!.rows[0];

  it("shows the device the conductor lands on, not the arrow", () => {
    const { doc } = folioProject();
    const r = side2(doc);
    expect(r.side2).toEqual(["K1:A1 (201)"]);
    expect(r.conn2[0]).toMatchObject({ to: ["K1:A1"], wire: "201" });
  });

  it("takes the conductor's colour and cross-section from its continuation on the other sheet", () => {
    const { doc, p2 } = folioProject();
    Object.assign(p2.wires[0], { insulation: "BU", section: "0.75 mm²" });
    const c = side2(doc).conn2[0];
    expect(c).toMatchObject({ color: "BU", hex: "#1f5fd1", section: "0.75 mm²" });
    expect(c.wires).toHaveLength(2);
  });

  it("a colour on the wire at the terminal wins; a junction branch is another conductor", () => {
    const { doc, p1, p2, c2, k1 } = folioProject();
    p1.wires[0].insulation = "RD";
    p2.wires[0].insulation = "BU";
    expect(side2(doc).conn2[0]).toMatchObject({ color: "RD" });
    // sheet 2: arrow → junction → K1 (blue): the branch after the junction is not this conductor's colour
    delete p1.wires[0].insulation;
    p2.wires = [
      { ...wire([c2.id, "r"], [k1.id, "a1"]), b: { k: "junction", j: "j1" } } as Wire,
      { ...wire([k1.id, "a1"], [k1.id, "a1"], { insulation: "BU" }), a: { k: "junction", j: "j1" } } as Wire,
    ];
    const c = side2(doc).conn2[0];
    expect(c.to).toEqual(["K1:A1"]);
    expect(c.wires).toHaveLength(2);
    expect(c.hex).toBeUndefined();
  });

  it("an arrow that is not linked is where the conductor ends", () => {
    const { doc, g, c2 } = folioProject();
    delete g.links;
    delete c2.links;
    expect(side2(doc).side2).toEqual(["24V"]);
  });

  it("follows one going arrow to every coming arrow, and chains over several sheets", () => {
    const { doc, p2, p3, g, k1 } = folioProject();
    // a second coming arrow on sheet 3 feeding Q1
    const c3 = el("come", "24V"), q1 = el("mcb", "Q1");
    p3.elements.push(c3, q1);
    p3.wires.push(wire([c3.id, "r"], [q1.id, "m1"]));
    link(g, c3);
    // and K1:A2 goes on from sheet 2 through another pair back to sheet 3 — not part of this conductor
    const g2 = el("go", "A2"), c4 = el("come", "A2"), k2 = el("coil", "K2");
    p2.elements.push(g2);
    p2.wires.push(wire([k1.id, "a2"], [g2.id, "r"]));
    p3.elements.push(c4, k2);
    p3.wires.push(wire([c4.id, "r"], [k2.id, "a1"]));
    link(g2, c4);
    expect(side2(doc).conn2[0].to.sort()).toEqual(["K1:A1", "Q1:1"]);
  });

  it("does not list the same terminal drawn on the other sheet as its own destination", () => {
    const { doc, p2, c2 } = folioProject();
    const x1b = el("term", "X1:1");
    p2.elements.push(x1b);
    p2.wires.push(wire([c2.id, "r"], [x1b.id, "t1"]));
    const r = side2(doc);
    expect(r.instances).toHaveLength(2);
    expect(r.side2).toEqual(["K1:A1 (201)"]);
    // the sheet 2 instance's top shares the coming arrow with K1:A1; X1:1 on sheet 1 is itself, not a destination
    expect(r.side1).toEqual(["K1:A1 (201)"]);
    expect([...r.side1, ...r.side2].some((t) => t.includes("X1:1"))).toBe(false);
  });
});
