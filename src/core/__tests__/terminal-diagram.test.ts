import { describe, expect, it } from "vitest";
import { addWire, newElement } from "../ops";
import { newPage } from "../doc";
import { toScene } from "../geometry";
import { builtinTerminalDef, createStrip, setRow } from "../terminals";
import { insertTerminalDiagram, terminalDiagramLayout, drawTerminalDiagram, terminalsPerSheet } from "../render/terminal-diagram";
import { buildXref } from "../xref";
import { docStyles } from "../render/scene";
import { duplicateRefs } from "../numbering";
import { mkDoc, twoPin } from "./helpers";

const measure = (t: string, s: number) => t.length * s * 0.6;

function project() {
  const { doc, page } = mkDoc();
  const t = builtinTerminalDef();
  const q = newElement(doc, page, twoPin("q"), { x: 200, y: 100 });
  q.info.label = "Q1";
  const x1 = newElement(doc, page, t, { x: 200, y: 300 });
  x1.info.label = "X1:1";
  const x2 = newElement(doc, page, t, { x: 260, y: 300 });
  x2.info.label = "X1:2";
  const a = toScene(q, doc.defs[q.defId].pins[1]), b = toScene(x1, t.pins[0]);
  addWire(page, { k: "pin", el: q.id, pin: doc.defs[q.defId].pins[1].id, p: a }, { k: "pin", el: x1.id, pin: "1", p: b }, [a, { x: a.x, y: b.y }, b], { label: "B001A", insulation: "BU" });
  setRow(doc, "X1", "1", { bridge: true });
  return { doc, page, x1 };
}

describe("terminal diagram sheet", () => {
  it("a terminal drawn twice is not a duplicate reference", () => {
    const { doc, page } = project();
    const again = newElement(doc, page, builtinTerminalDef(), { x: 500, y: 300 });
    again.info.label = "X1:1";
    expect(duplicateRefs(doc).size).toBe(0);
  });

  it("inserts a generated sheet with the strip, connections and bridges", () => {
    const { doc, page, x1 } = project();
    const ids = insertTerminalDiagram(doc, "X1", { afterPageId: page.id, newPage });
    expect(ids.length).toBe(1);
    const sheet = doc.pages.find((p) => p.id === ids[0])!;
    expect(sheet.kind).toBe("terminals");
    expect(sheet.order).toBe(page.order + 1);
    const L = terminalDiagramLayout(doc, sheet, docStyles(doc));
    expect(L.cells.map((c) => c.ref)).toEqual(["X1:1", "X1:2"]);
    expect(L.cells[0].row.conn1[0]).toMatchObject({ wire: "B001A", to: ["Q1:2"] });
    expect(L.cells[0].row.row?.bridge).toBe(true);
    // cells sit side by side in one box
    expect(L.cells[1].rect.x).toBeCloseTo(L.cells[0].rect.x + L.cells[0].rect.w);
    // draws without throwing
    const calls: string[] = [];
    const pt = { kind: "svg", save() {}, restore() {}, transform() {}, stroke: () => calls.push("s"), fill: () => calls.push("f"), text: (t: { text: string }) => calls.push(t.text), measure, scale: () => 1 } as never;
    drawTerminalDiagram(pt, doc, sheet, docStyles(doc), measure);
    expect(calls).toContain("B001A");
    expect(calls).toContain("Q1:2");
    // the cell links to the schematic symbol
    const x = buildXref(doc, measure);
    const cell = x.occ.find((o) => o.kind === "terminal" && o.text === "X1:1")!;
    expect(x.groups[cell.group].map((i) => x.occ[i].id)).toContain(x1.id);
  });

  it("splits a long strip over sheets and re-splits in place", () => {
    const { doc, page } = mkDoc();
    createStrip(doc, "X7", 150);
    const per = terminalsPerSheet(page);
    const ids = insertTerminalDiagram(doc, "X7", { afterPageId: page.id, newPage });
    expect(ids.length).toBe(Math.ceil(150 / per));
    const pages = ids.map((id) => doc.pages.find((p) => p.id === id)!);
    expect(pages[0].terminalDiagram).toEqual({ tag: "X7", from: 1, to: per });
    expect(pages[pages.length - 1].terminalDiagram?.to).toBeUndefined();
    const again = insertTerminalDiagram(doc, "X7", { perSheet: 50, newPage });
    expect(again.length).toBe(3);
    expect(again[0]).toBe(ids[0]);
    expect(doc.pages.filter((p) => p.kind === "terminals").length).toBe(3);
  });
});

describe("terminal connections on both sides", () => {
  it("a one-pin terminal in a line has a top and a bottom connection", async () => {
    const { mkDef } = await import("./helpers");
    const { collectStrips } = await import("../terminals");
    const { doc, page } = mkDoc();
    const t1 = mkDef("t1pin", [{ id: "1", x: 0, y: 0, orient: "n" }], { linkType: "terminal", name: "terminal", prefix: "X" });
    const q = newElement(doc, page, twoPin("q"), { x: 200, y: 100 });
    q.info.label = "Q1";
    const k = newElement(doc, page, twoPin("k"), { x: 200, y: 500 });
    k.info.label = "K1";
    const x = newElement(doc, page, t1, { x: 200, y: 300 });
    x.info.label = "X0:1";
    const qp = toScene(q, doc.defs[q.defId].pins[1]), kp = toScene(k, doc.defs[k.defId].pins[0]), xp = toScene(x, t1.pins[0]);
    addWire(page, { k: "pin", el: q.id, pin: doc.defs[q.defId].pins[1].id, p: qp }, { k: "pin", el: x.id, pin: "1", p: xp }, [qp, { x: xp.x, y: qp.y }, xp], { label: "L1" });
    addWire(page, { k: "pin", el: x.id, pin: "1", p: xp }, { k: "pin", el: k.id, pin: doc.defs[k.defId].pins[0].id, p: kp }, [xp, { x: xp.x, y: kp.y }, kp], { label: "L1.1" });
    const row = collectStrips(doc).find((v) => v.tag === "X0")!.rows[0];
    expect(row.conn1.map((c) => [c.wire, c.to])).toEqual([["L1", ["Q1:2"]]]);
    expect(row.conn2.map((c) => [c.wire, c.to])).toEqual([["L1.1", ["K1:1"]]]);
  });

  it("a two-pin terminal wired top and bottom, two conductors on top", async () => {
    const { collectStrips } = await import("../terminals");
    const { doc, page } = mkDoc();
    const t = builtinTerminalDef();
    const a = newElement(doc, page, twoPin("a"), { x: 100, y: 100 });
    a.info.label = "F1";
    const b = newElement(doc, page, twoPin("b"), { x: 300, y: 100 });
    b.info.label = "F2";
    const c = newElement(doc, page, twoPin("c"), { x: 200, y: 500 });
    c.info.label = "M1";
    const x = newElement(doc, page, t, { x: 200, y: 300 });
    x.info.label = "X1:1";
    const top = toScene(x, t.pins[0]), bot = toScene(x, t.pins[1]);
    for (const s of [a, b]) {
      const p = toScene(s, doc.defs[s.defId].pins[1]);
      addWire(page, { k: "pin", el: s.id, pin: doc.defs[s.defId].pins[1].id, p }, { k: "pin", el: x.id, pin: "1", p: top }, [p, { x: top.x, y: p.y }, top]);
    }
    const cp = toScene(c, doc.defs[c.defId].pins[0]);
    addWire(page, { k: "pin", el: x.id, pin: "2", p: bot }, { k: "pin", el: c.id, pin: doc.defs[c.defId].pins[0].id, p: cp }, [bot, { x: bot.x, y: cp.y }, cp]);
    const row = collectStrips(doc).find((v) => v.tag === "X1")!.rows[0];
    expect(row.conn1.map((q) => q.to[0]).sort()).toEqual(["F1:2", "F2:2"]);
    expect(row.conn2.map((q) => q.to[0])).toEqual(["M1:1"]);
  });
});
