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
