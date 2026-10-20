import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { produce } from "immer";
import { importQet } from "@/core/qet";
import { projectNets } from "@/core/erc";
import { collectStrips } from "@/core/terminals";
import { toScene } from "@/core/geometry";
import type { Doc } from "@/core/model";
import { allElements, findComponent, findComponents, findPage, findPin, findWires, sheets, short } from "../doc";
import { arrangeComponents, convertLines, copyComponents, drawWire, folioReports, mateConnectors, moveComponent, replaceSymbols, routeWire, setCable, setComponentDataMany, setSymbolPins, setWires, straighten, styleComponents } from "../edits";
import { moveCableTag, moveLabels } from "../labels";
import { parseArgs } from "../args";
import { z } from "zod";
import { newDoc } from "@/core/doc";
import { addWire, newElement } from "@/core/ops";
import { mkDef } from "@/core/__tests__/helpers";
import { addPage, addShape, addText, connectShapes, deleteItems, deletePage, editTitleBlock, pageItemsText, setCover, updateItem, updatePage } from "../sheets";
import { cablesText, editStrip, placeStripTerminals, reportCsv, reportTable, settingsText, stripsText, updateSettings } from "../project";

const FIX = path.join(__dirname, "..", "..", "..", "core", "qet", "__fixtures__", "projects", "2612_ats_singlephase.qet");
const load = (): Doc => importQet(readFileSync(FIX, "utf8"), "ats.qet").doc;
const edit = <T,>(doc: Doc, f: (d: Doc) => T): { doc: Doc; out: T } => {
  let out!: T;
  const next = produce(doc, (d: Doc) => void (out = f(d)));
  return { doc: next, out };
};

describe("MCP: labels, conductors, batches", () => {
  /** device —w1— feed-through terminal —w2— going arrow ⇒ page 2: coming arrow —w3— device */
  function chain() {
    const doc = newDoc("t");
    const page = doc.pages[0];
    const dev = mkDef("dev", [{ id: "1", x: 10, y: 0, orient: "e" }], { name: "Lamp" });
    const term = mkDef("term", [{ id: "a", x: -10, y: 0, orient: "w", number: "1" }, { id: "b", x: 10, y: 0, orient: "e", number: "1" }], { name: "Terminal", linkType: "terminal", prefix: "X" });
    const rep = mkDef("rep", [{ id: "1", x: -10, y: 0, orient: "w" }], { linkType: "next_report", prefix: "", name: "Arrow" });
    const d1 = newElement(doc, page, dev, { x: 105, y: 105 });
    d1.info.label = "H1";
    const t1 = newElement(doc, page, term, { x: 205, y: 105 });
    t1.info.label = "X1";
    const r1 = newElement(doc, page, rep, { x: 305, y: 105 });
    r1.info.label = "SP1";
    r1.texts = [{ id: "ref", role: "componentRef", info: "label", text: "", x: null, y: null }];
    const page2 = { ...structuredClone(page), id: "p2", title: "Two", elements: [], wires: [], junctions: [], texts: [], shapes: [], order: 1 };
    doc.pages.push(page2);
    const r2 = newElement(doc, page2, { ...rep, id: "rep2", linkType: "previous_report", pins: [{ ...rep.pins[0], x: 10, orient: "e" }] }, { x: 105, y: 105 });
    r2.info.label = "SP1";
    const d2 = newElement(doc, page2, { ...dev, id: "dev2", pins: [{ ...dev.pins[0], x: -10, orient: "w" }] }, { x: 305, y: 105 });
    d2.info.label = "H2";
    r1.links = [r2.id];
    r2.links = [r1.id];
    const w = (pg: typeof page, a: typeof d1, pa: string, b: typeof d1, pb: string) => {
      const p1 = toScene(a, doc.defs[a.defId].pins.find((p) => p.id === pa)!), p2 = toScene(b, doc.defs[b.defId].pins.find((p) => p.id === pb)!);
      return addWire(pg, { k: "pin", el: a.id, pin: pa, p: p1 }, { k: "pin", el: b.id, pin: pb, p: p2 }, [p1, p2])!;
    };
    const w1 = w(page, d1, "1", t1, "a"), w2 = w(page, t1, "b", r1, "1"), w3 = w(page2, r2, "1", d2, "1");
    return { doc, w1, w2, w3 };
  }

  it("apply_to_net carries the size through terminals and off-page arrows", () => {
    const { doc, w1, w2, w3 } = chain();
    const r = edit(doc, (d) => setWires(d, [w1.id], { section: "1.5 mm²" }, { applyToNet: true }));
    expect(r.out).toMatch(/copied to 2 other wires of the same conductor .* on pages 1, 2/);
    const all = r.doc.pages.flatMap((p) => p.wires);
    for (const id of [w2.id, w3.id]) expect(all.find((x) => x.id === id)!.section).toBe("1.5 mm²");
  });

  it("moves a component and reports where it is now", () => {
    const { doc } = chain();
    const r = edit(doc, (d) => moveComponent(d, "H1", { dx: 20, dy: 10 }));
    const e = findComponent(r.doc, "H1").e;
    expect([e.x, e.y]).toEqual([125, 115]);
    expect(r.out).toContain("by (20, 10) to x=125 y=115");
  });

  it("moves labels: an arrow's cross-reference, every arrow on a sheet, reset", () => {
    const { doc } = chain();
    let r = edit(doc, (d) => moveLabels(d, ["SP1@1"], ["xref"], { dy: 15 }));
    expect(r.out).toMatch(/Moved the cross-reference of 1 component by \(0, 15\)/);
    expect(findComponent(r.doc, "SP1@1").e.xrefPos).toBeTruthy();
    r = edit(r.doc, (d) => moveLabels(d, "all", ["all"], { side: "above", page: "2", onlyArrows: true }));
    expect(r.out).toMatch(/of 1 component above the symbol/);
    expect(r.out).toMatch(/SP1@2: reference at .*cross-reference at/);
    expect(findComponent(r.doc, "SP1@2").e.xrefPos).toBeTruthy();
    r = edit(r.doc, (d) => moveLabels(d, ["SP1"], ["all"], { reset: true }));
    expect(findComponent(r.doc, "SP1@1").e.xrefPos).toBeUndefined();
    expect(findComponent(r.doc, "SP1@2").e.xrefPos).toBeUndefined();
    expect(() => edit(doc, (d) => moveLabels(d, ["H1"], ["xref"], { dx: 5 }))).toThrow(/None of them shows cross-reference/);
    expect(() => edit(doc, (d) => moveLabels(d, ["SP1"], ["all"], {}))).toThrow(/Say where/);
  });

  it("sets data on many components at once, listing the ones it cannot find", () => {
    const { doc } = chain();
    const r = edit(doc, (d) =>
      setComponentDataMany(d, [
        { ref: "H1", fields: { description: "Status lamp" } },
        { ref: "SP1@1", fields: { comment: "to RGB" } },
        { ref: "NOPE", fields: { description: "x" } },
      ]),
    );
    expect(r.out.split("\n")[0]).toBe("Set data on 2 of 3 components; 1 not set");
    expect(r.out).toMatch(/NOPE:/);
    expect(findComponent(r.doc, "H1").e.info.description).toBe("Status lamp");
    expect(findComponent(r.doc, "SP1@1").e.info.comment).toBe("to RGB");
  });

  it("moves a cable's tag", () => {
    const { doc, w1 } = chain();
    doc.cables = [{ id: "c", tag: "W15", cores: [] }];
    doc.pages[0].wires.find((x) => x.id === w1.id)!.cable = "W15";
    const r = edit(doc, (d) => moveCableTag(d, "W15", { side: "below", dx: 4 }));
    expect(r.out).toMatch(/^W15 tag moved — page 1: mark at x = \d+ \(along [\d.]+ of \d+–\d+\), tag at/);
    expect(r.doc.cables![0].marks?.[doc.pages[0].id]?.label).toBeTruthy();
    expect(() => edit(doc, (d) => moveCableTag(d, "W99", { dx: 1 }))).toThrow(/No cable W99/);
  });

  it("reads objects sent as JSON text (like add_text's box)", () => {
    const schema = z.object({ text: z.string(), box: z.union([z.object({ width: z.number().min(0).optional() }), z.literal("none")]).optional() });
    expect(parseArgs(schema, { text: "[1] stays text", box: '{"width": 0}' })).toMatchObject({ ok: true, data: { text: "[1] stays text", box: { width: 0 } } });
    expect(parseArgs(schema, { text: "t", box: "none" })).toMatchObject({ ok: true, data: { box: "none" } });
    const bad = parseArgs(schema, { text: "t", box: { width: -5 } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/box\.width: Too small/);
  });
});

describe("MCP: components", () => {
  it("mates two connector halves: pins pair up, nets run through, unmate clears both", () => {
    const { doc, out } = edit(load(), (d) => mateConnectors(d, "U2@1", "U3@1", { gender: "male" }));
    const u2 = findComponent(doc, "U2@1").e, u3 = findComponent(doc, "U3@1").e;
    expect(u2.mate).toEqual({ id: u3.id, gender: "male" });
    expect(u3.mate).toEqual({ id: u2.id, gender: "female" });
    expect(out).toMatch(/Mated U2 \(male, page 1\) ↔ U3 \(female, page 1\): 13 pins connected/);
    const def2 = doc.defs[u2.defId], def3 = doc.defs[u3.defId];
    const { netOfPin } = projectNets(doc);
    const n2 = netOfPin.get(`${u2.id}/${def2.pins[0].id}`) ?? netOfPin.get(`p:${u2.id}/${def2.pins[0].id}`);
    const n3 = netOfPin.get(`${u3.id}/${def3.pins[0].id}`) ?? netOfPin.get(`p:${u3.id}/${def3.pins[0].id}`);
    expect(n2).toBeDefined();
    expect(n2).toBe(n3);
    const un = edit(doc, (d) => mateConnectors(d, "U2@1", ""));
    expect(findComponent(un.doc, "U2@1").e.mate).toBeUndefined();
    expect(findComponent(un.doc, "U3@1").e.mate).toBeUndefined();
    expect(() => edit(load(), (d) => mateConnectors(d, "U2@1", "U2@1"))).toThrow(/itself/);
    expect(() => edit(load(), (d) => mateConnectors(d, "U2", "U3@1"))).toThrow(/has 2 parts/);
  });

  it("re-mating moves a mate and says so", () => {
    let doc = edit(load(), (d) => mateConnectors(d, "U2@1", "U3@1")).doc;
    const r = edit(doc, (d) => mateConnectors(d, "U1@1", "U3@1"));
    doc = r.doc;
    expect(findComponent(doc, "U2@1").e.mate).toBeUndefined();
    expect(findComponent(doc, "U3@1").e.mate?.id).toBe(findComponent(doc, "U1@1").e.id);
    expect(r.out).toMatch(/no longer mated: U2/);
  });

  it("rotates, mirrors, resizes, locks and aligns", () => {
    const base = load();
    const k2 = findComponent(base, "K2@1").e;
    let doc = edit(base, (d) => arrangeComponents(d, ["K2@1"], { rotate: 90, mirrored: true, scale: 150 })).doc;
    let e = findComponent(doc, "K2@1").e;
    expect([e.rot, e.mirror, e.scale]).toEqual([(k2.rot + 1) % 4, !k2.mirror, 1.5]);
    doc = edit(doc, (d) => arrangeComponents(d, ["K2@1"], { rotation: 0, scale: 100, locked: true })).doc;
    e = findComponent(doc, "K2@1").e;
    expect([e.rot, e.scale, e.locked]).toEqual([0, undefined, true]);
    expect(() => edit(doc, (d) => arrangeComponents(d, ["K2@1"], { rotate: 90 }))).toThrow(/locked/);
    doc = edit(doc, (d) => arrangeComponents(d, ["K2@1"], { locked: false, rotate: 90 })).doc;
    expect(findComponent(doc, "K2@1").e.rot).toBe(1);
    const al = edit(load(), (d) => arrangeComponents(d, ["K1@1", "K2@1", "K3@1"], { align: "top" })).doc;
    const ys = ["K1@1", "K2@1", "K3@1"].map((r) => findComponent(al, r).e.y);
    expect(new Set(ys).size).toBe(1);
    expect(() => edit(load(), (d) => arrangeComponents(d, ["K1@1", "K1@3"], { align: "left" }))).toThrow(/one page/);
  });

  it("styles components: pins, info lines, reference direction, colour, outline, texts", () => {
    const { doc, out } = edit(load(), (d) =>
      styleComponents(d, ["U1@1"], { pinNumbers: true, showInfo: { name: true, part_number: false }, infoPlacement: "right", referenceDirection: "vertical", symbolColour: "#ff0000", outline: { show: true, color: "#0000ff", dash: "dashed" }, texts: [{ text: "reference", size: 12, bold: true }] }),
    );
    const e = findComponent(doc, "U1@1").e;
    expect(e.showPinNumbers).toBe(true);
    expect(e.showInfo).toMatchObject({ description: true, manufacturer_reference: false });
    expect(e.infoLayout?.at).toBe("right");
    expect(e.texts.find((t) => t.info === "label")?.rotation).toBe(90);
    expect(e.texts.find((t) => t.info === "label")?.override).toMatchObject({ size: 12, weight: 700 });
    expect(e.outlineOverride?.color).toBe("#ff0000");
    expect(e.frame).toMatchObject({ show: true, color: "#0000ff", dash: "dashed" });
    expect(out).toMatch(/U1:/);
    const reset = edit(doc, (d) => styleComponents(d, ["U1@1"], { resetOverrides: true, projectDefault: true })).doc;
    const r = findComponent(reset, "U1@1").e;
    expect([r.outlineOverride, r.frame, r.showInfo]).toEqual([undefined, undefined, undefined]);
    expect(reset.styles.graphics?.componentInfo).toMatchObject({ description: true });
    expect(() => edit(load(), (d) => styleComponents(d, ["U1"], { texts: [{ text: "nope" }] }))).toThrow(/no text/);
  });

  it("off-page arrows: auto links, refuses non-arrows", () => {
    expect(edit(load(), (d) => folioReports(d, "auto")).out).toMatch(/arrow/);
    expect(() => edit(load(), (d) => folioReports(d, "link", "K1@1", "K2@1"))).toThrow(/not marked/);
    expect(() => edit(load(), (d) => folioReports(d, "mark_going", "K1@1"))).toThrow(/does not look like/);
  });

  it("replaces a symbol keeping the wires", () => {
    const base = load();
    const lamp = findComponents(base, "#b274f709")[0].def!;
    const k2 = findComponent(base, "K2@1").e;
    const wired = (d: Doc, id: string) => d.pages.flatMap((p) => p.wires).filter((w) => (w.a.k === "pin" && w.a.el === id) || (w.b.k === "pin" && w.b.el === id)).length;
    const before = wired(base, k2.id);
    const { doc, out } = edit(base, (d) => replaceSymbols(d, ["K2@1"], lamp));
    expect(findComponent(doc, "K2@1").e.defId).toBe(lamp.id);
    expect(wired(doc, k2.id)).toBe(before);
    expect(out).toMatch(/now drawn as/);
  });

  it("edits a symbol's pins for every component using it", () => {
    const { doc, out } = edit(load(), (d) => setSymbolPins(d, "K1@1", [{ pin: "p1", number: "A1", kind: "DC+", volts: 24 }, { pin: "p2", number: "A2", kind: "DC0" }]));
    const pin = findPin(doc, "K1@1:A1").pin;
    expect([pin.number, pin.cls, pin.volts]).toEqual(["A1", "DC+", 24]);
    expect(findPin(doc, "K2@1:A2").pin.cls).toBe("DC0"); // same coil symbol
    expect(out).toMatch(/components in this project/);
    expect(() => edit(load(), (d) => setSymbolPins(d, "K1@1", [{ pin: "p1", kind: "24V" }]))).toThrow(/kind must be/);
  });

  it("copies a circuit to another page with new references", () => {
    const base = load();
    const n3 = findPage(base, 3).elements.length;
    const { doc, out } = edit(base, (d) => copyComponents(d, ["K2@1", "#af3c41a3"], { toPage: "3" }));
    expect(findPage(doc, 3).elements.length).toBe(n3 + 2);
    expect(out).toMatch(/to page 3/);
    const added = findPage(doc, 3).elements.slice(-2);
    expect(added[0].info.label).toMatch(/^K\d+$/);
    expect(added[0].info.label).not.toBe("K2");
  });
});

describe("MCP: wires", () => {
  it("draws a wire from a pin to a free point and a T onto an existing wire", () => {
    const base = load();
    const r1 = edit(base, (d) => drawWire(d, { pin: "K2@1:p1" }, { cell: "13A" }));
    const w1 = findWires(r1.doc, short(r1.out.wireId))[0].w;
    expect(w1.a.k).toBe("pin");
    expect(w1.b.k).toBe("free");
    // a long straight run: connect in its middle
    const target = findPage(base, 1).wires.find((w) => w.pts.length === 2 && Math.abs(w.pts[0].x - w.pts[1].x) + Math.abs(w.pts[0].y - w.pts[1].y) >= 80)!;
    const mid = { x: Math.round((target.pts[0].x + target.pts[1].x) / 20) * 10 + 5, y: Math.round((target.pts[0].y + target.pts[1].y) / 20) * 10 + 5 };
    const before = findPage(base, 1).junctions.length;
    const r2 = edit(base, (d) => drawWire(d, { pin: "QF4@1:p1" }, { wire: short(target.id), at: mid }));
    expect(findPage(r2.doc, 1).junctions.length).toBe(before + 1);
    expect(r2.out.text).toMatch(/QF4:p1 → wire/);
    expect(() => edit(base, (d) => drawWire(d, { pin: "K2@1:p1" }, { pin: "K5@3:p1" }))).toThrow(/page/);
  });

  it("straightens wires and says what stayed bent and why", () => {
    const base = edit(load(), (d) => arrangeComponents(d, ["K2@1"], { scale: 146 })).doc;
    const k2 = findComponent(base, "K2@1").e;
    const r = edit(base, (d) => straighten(d, "1", { components: ["K2@1"] }));
    expect(r.out).toMatch(/^Page 1: \d+ wires? straight; \d+ wires on the page still bend/);
    expect(r.out).toMatch(/Stayed: K2 \(1 of 2 wires in line/);
    expect(r.out).toMatch(/Pins off the grid .*K2 at 146 %/);
    expect(() => edit(base, (d) => straighten(d, "1", { components: ["K2@2"] }))).toThrow();
    // only redraw: nothing moves
    const only = edit(base, (d) => straighten(d, "1", {}));
    expect(findComponent(only.doc, "K2@1").e).toMatchObject({ x: k2.x, y: k2.y, scale: k2.scale });
  });

  it("re-routes, sets a path and reconnects", () => {
    const base = load();
    const r = edit(base, (d) => drawWire(d, { pin: "K2@1:p1" }, { cell: "13A" }));
    const id = short(r.out.wireId);
    const w = findWires(r.doc, id)[0].w;
    const a = w.pts[0], b = w.pts[w.pts.length - 1];
    const p = edit(r.doc, (d) => routeWire(d, id, { points: [a, { x: a.x, y: b.y }, b] }));
    expect(findWires(p.doc, id)[0].w.pts.length).toBeGreaterThanOrEqual(2);
    expect(() => edit(r.doc, (d) => routeWire(d, id, { points: [{ x: 0, y: 0 }, b] }))).toThrow(/start is connected/);
    const k3 = findPin(base, "K3@1:p1");
    const c = edit(r.doc, (d) => routeWire(d, id, { reconnect: { end: "end", to: { pin: "K3@1:p1" } } }));
    const cw = findWires(c.doc, id)[0].w;
    expect(cw.b).toEqual({ k: "pin", el: k3.e.id, pin: k3.pin.id });
    expect(cw.pts[cw.pts.length - 1]).toEqual(toScene(k3.e, k3.pin));
  });

  it("sets supply, markers, label position, bus, line style and copies data to the net", () => {
    const base = load();
    const w = findPage(base, 1).wires[0];
    const { doc, out } = edit(base, (d) => setWires(d, [w.id], { supply: "B", endStart: "X1:1", labelPos: 0.3, bus: true, line: { color: "#ff0000" }, colour: "BU", section: "0.75 mm²" }, { applyToNet: true }));
    const x = findWires(doc, short(w.id))[0].w;
    expect([x.vclass, x.endLabels?.a, x.labelPos, x.bus, x.override?.color]).toEqual(["24v", "X1:1", 0.3, true, "#ff0000"]);
    expect(out).toMatch(/copied to \d+ other wire/);
    expect(() => edit(base, (d) => setWires(d, [w.id], { supply: "Q" }))).toThrow(/No supply/);
    const cleared = edit(doc, (d) => setWires(d, [w.id], { supply: "", labelPos: null, line: null, bus: false })).doc;
    const y = findWires(cleared, short(w.id))[0].w;
    expect([y.vclass, y.labelPos, y.override, y.bus]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("converts drawn lines into wires", () => {
    const base = load();
    const pin = findPin(base, "K2@1:p1");
    const p = toScene(pin.e, pin.pin);
    const drawn = edit(base, (d) => addShape(d, "1", "line", [p, { x: p.x, y: p.y - 40 }], {})).doc;
    const { doc, out } = edit(drawn, (d) => convertLines(d, "1"));
    expect(out).toMatch(/Converted \d+ lines? into \d+ wires?/);
    expect(findPage(doc, 1).shapes.filter((s) => s.kind === "line").length).toBe(0);
  });

  it("creates a cable, assigns cores, renames and deletes it", () => {
    const base = load();
    const ws = findPage(base, 1).wires.slice(0, 3).map((w) => short(w.id));
    let r = edit(base, (d) => setCable(d, undefined, { addWires: ws, type: "ÖLFLEX 4G1,5", section: "1.5 mm²" }));
    expect(r.out).toMatch(/Created cable W1/);
    expect(findWires(r.doc, ws[0])[0].w.cable).toBe("W1");
    expect(findWires(r.doc, ws[0])[0].w.core).toBeTruthy();
    expect(cablesText(r.doc)).toMatch(/W1 — ÖLFLEX 4G1,5/);
    r = edit(r.doc, (d) => setCable(d, "W1", { rename: "W7" }));
    expect(findWires(r.doc, ws[1])[0].w.cable).toBe("W7");
    r = edit(r.doc, (d) => setCable(d, "W7", { delete: true }));
    expect(findWires(r.doc, ws[1])[0].w.cable).toBeUndefined();
    expect(r.doc.cables).toEqual([]);
  });
});

describe("MCP: pages and annotations", () => {
  it("adds, copies, moves, sets up, archives and deletes pages", () => {
    let doc = load();
    let r = edit(doc, (d) => addPage(d, { title: "Safety circuit", after: "1" }));
    doc = r.doc;
    expect(findPage(doc, 2).title).toBe("Safety circuit");
    doc = edit(doc, (d) => addPage(d, { kind: "cover" })).doc;
    expect(findPage(doc, 1).kind).toBe("cover");
    doc = edit(doc, (d) => addPage(d, { kind: "contents" })).doc;
    expect(findPage(doc, 2).kind).toBe("contents");
    r = edit(doc, (d) => addPage(d, { duplicate: "3", title: "Copy" }));
    doc = r.doc;
    expect(sheets(doc).find((p) => p.title === "Copy")!.elements.length).toBe(findPage(doc, 3).elements.length);
    doc = edit(doc, (d) => updatePage(d, "Safety circuit", { title: "Safety", position: 1, border: { columns: 20 }, titleBlock: { fields: { author: "NS" } } })).doc;
    const s = findPage(doc, 1);
    expect([s.title, s.border.cols, s.titleBlock.fields.author]).toEqual(["Safety", 20, "NS"]);
    doc = edit(doc, (d) => updatePage(d, "Safety", { archived: true })).doc;
    expect(sheets(doc).some((p) => p.title === "Safety")).toBe(false);
    doc = edit(doc, (d) => updatePage(d, "Safety", { archived: false })).doc;
    expect(sheets(doc).some((p) => p.title === "Safety")).toBe(true);
    const n = sheets(doc).length;
    doc = edit(doc, (d) => deletePage(d, "Copy")).doc;
    expect(sheets(doc).length).toBe(n - 1);
    expect(() => edit(doc, (d) => updatePage(d, "Safety", { titleBlock: { template: "nope" } }))).toThrow(/No title block template/);
  });

  it("edits the cover sheet", () => {
    const withCover = edit(load(), (d) => addPage(d, { kind: "cover" })).doc;
    const { doc } = edit(withCover, (d) => setCover(d, undefined, { subtitle: "Wiring", setFields: [{ label: "Supply voltage", value: "48 V DC" }, { label: "IP rating", value: "IP54" }, { label: "Serial number", value: "", remove: true }], showRevisions: false }));
    const c = findPage(doc, 1).cover!;
    expect(c.subtitle).toBe("Wiring");
    expect(c.fields.find((f) => f.label === "Supply voltage")?.value).toBe("48 V DC");
    expect(c.fields.some((f) => f.label === "IP rating")).toBe(true);
    expect(c.fields.some((f) => f.label === "Serial number")).toBe(false);
    expect(c.showRevisions).toBe(false);
    expect(() => edit(load(), (d) => setCover(d, undefined, { title: "x" }))).toThrow(/no cover sheet/);
  });

  it("adds, changes and deletes texts and shapes", () => {
    let r = edit(load(), (d) => addText(d, "1", { cell: "3B" }, { text: "**Safety** circuit", size: 14, bold: true, box: { width: 200, border: { colour: "#000", width: 1 } } }));
    const tid = /Text (#[0-9a-f]{8})/.exec(r.out)![1];
    let doc = r.doc;
    const t = findPage(doc, 1).texts.find((x) => short(x.id) === tid)!;
    expect(t.override).toMatchObject({ size: 14, weight: 700 });
    expect(t.rich?.width).toBe(200);
    r = edit(doc, (d) => addShape(d, "1", "rect", [{ x: 100, y: 100 }, { x: 300, y: 200 }], { dash: "dashed", colour: "#ff0000" }));
    const sid = /Rectangle (#[0-9a-f]{8})/.exec(r.out)![1];
    doc = r.doc;
    expect(pageItemsText(doc, "1")).toContain(sid);
    doc = edit(doc, (d) => updateItem(d, tid, { text: "Safety", dx: 20 })).doc;
    expect(findPage(doc, 1).texts.find((x) => short(x.id) === tid)!.x).toBe(t.x + 20);
    doc = edit(doc, (d) => updateItem(d, sid, { fill: "#eeeeee", width: 2 })).doc;
    expect(findPage(doc, 1).shapes.find((x) => short(x.id) === sid)).toMatchObject({ fill: "#eeeeee", width: 2 });
    doc = edit(doc, (d) => deleteItems(d, [tid, sid])).doc;
    expect(pageItemsText(doc, "1")).not.toContain(sid);
  });

  it("draws a block diagram: text boxes, forms, arrows between boxes, text styles", () => {
    let r = edit(load(), (d) => addShape(d, "1", "textbox", [{ x: 100, y: 100 }, { x: 240, y: 160 }], { label: "**Battery**\n48 V", labelStyle: { size: 12, align: "left" }, fill: "#e0f2fe" }));
    expect(r.out).toMatch(/^Text box #[0-9a-f]{8} on page 1 .* with "\*\*Battery\*\* 48 V"/);
    const a = /#[0-9a-f]{8}/.exec(r.out)![0];
    r = edit(r.doc, (d) => addShape(d, "1", "diamond", [{ x: 400, y: 100 }, { x: 520, y: 160 }], { label: "Charging?" }));
    const b = /#[0-9a-f]{8}/.exec(r.out)![0];
    r = edit(r.doc, (d) => connectShapes(d, a, b, { label: "48 V DC" }));
    expect(r.out).toMatch(/^Arrow #[0-9a-f]{8}/);
    let doc = r.doc;
    const shapes = findPage(doc, 1).shapes;
    const box = shapes.find((x) => short(x.id) === a)!;
    expect(box).toMatchObject({ kind: "rect", fill: "#e0f2fe", label: { text: "**Battery**\n48 V", size: 12, align: "left" } });
    expect(shapes.find((x) => short(x.id) === b)).toMatchObject({ kind: "rect", form: "diamond", label: { text: "Charging?" } });
    const arrow = shapes[shapes.length - 1];
    expect(arrow).toMatchObject({ kind: "line", arrows: { end: true }, label: { text: "48 V DC" }, pts: [{ x: 240, y: 130 }, { x: 400, y: 130 }] });
    const items = pageItemsText(doc, "1");
    expect(items).toMatch(/text box \| .* \| "\*\*Battery\*\* 48 V" 12pt left/);
    expect(items).toMatch(/arrow \(arrow at end\)/);
    expect(items).toMatch(/diamond \|/);
    // change: outline, text, style, arrows; no outline for a text box
    doc = edit(doc, (d) => updateItem(d, b, { outline: "hexagon", label: "Charger", bold: true })).doc;
    expect(findPage(doc, 1).shapes.find((x) => short(x.id) === b)).toMatchObject({ form: "hexagon", label: { text: "Charger", bold: true } });
    doc = edit(doc, (d) => updateItem(d, short(arrow.id), { arrows: "both", label: "" })).doc;
    const ar = findPage(doc, 1).shapes.find((x) => x.id === arrow.id)!;
    expect(ar.arrows).toEqual({ start: true, end: true });
    expect(ar.label).toBeUndefined();
    doc = edit(doc, (d) => updateItem(d, a, { width: 0, labelStyle: { size: null, valign: "top" } })).doc;
    expect(findPage(doc, 1).shapes.find((x) => short(x.id) === a)).toMatchObject({ width: 0, label: { text: "**Battery**\n48 V", align: "left", valign: "top" } });
    expect(findPage(doc, 1).shapes.find((x) => short(x.id) === a)!.label!.size).toBeUndefined();
    // refused: arrows on a box, no outline without text, an outline for a line
    expect(() => edit(doc, (d) => updateItem(d, b, { arrows: "end" }))).toThrow(/lines/);
    expect(() => edit(doc, (d) => addShape(d, "1", "rect", [{ x: 0, y: 0 }, { x: 50, y: 50 }], { width: 0 }))).toThrow(/text boxes/);
    expect(() => edit(doc, (d) => updateItem(d, short(arrow.id), { outline: "diamond" }))).toThrow(/boxes/);
  });

  it("edits a title block template", () => {
    const { doc, out } = edit(load(), (d) =>
      editTitleBlock(d, "default", [
        { op: "set_cell", row: 0, col: 0, value: "%author", label: "Drawn by" },
        { op: "insert_row", at: 2, height: 20 },
        { op: "add_field", row: 2, col: 0, value: "%checked", label: "Checked" },
      ]),
    );
    const t = doc.titleBlocks.default;
    expect(t.rows.length).toBe(3);
    expect(t.cells.some((c) => c.row === 2 && c.value === "%checked")).toBe(true);
    expect(t.cells.find((c) => c.row === 0 && c.col === 0)?.label).toBe("Drawn by");
    expect(out).toMatch(/used by \d+ page/);
    const copy = edit(load(), (d) => editTitleBlock(d, "default", [{ op: "set_cell", row: 0, col: 0, value: "x" }], { copyAs: "mine" })).doc;
    expect(copy.titleBlocks.mine.name).toBe("mine");
    expect(() => edit(load(), (d) => editTitleBlock(d, "default", [{ op: "set_cell", row: 9, col: 9, value: "x" }]))).toThrow(/No cell/);
  });
});

describe("MCP: project settings, terminals, reports", () => {
  it("changes settings", () => {
    const { doc } = edit(load(), (d) =>
      updateSettings(d, {
        properties: { machine: "GT-OMNI", saveddate: "" },
        addRevision: { rev: "B", date: "2026-10-20", description: "Safety circuit", drawn: "NS" },
        numbering: { rules: [{ match: "*", prefix: "", scope: "page", format: "{page}{prefix}{n}", start: 1 }], closeGapsOnDelete: false },
        wireNumbering: { format: "{class}{n:4}", classes: [{ letter: "A", name: "48 V DC", kind: "dc", volts: 48 }, { letter: "B", name: "24 V DC", kind: "dc", volts: 24 }] },
        wiring: { standard: "nfpa", destination: true },
        styles: { text: { componentRef: { size: 12 } }, graphics: { wire: { width: 2 } } },
      }),
    );
    expect(doc.meta.props.machine).toBe("GT-OMNI");
    expect(doc.meta.props.saveddate).toBeUndefined();
    expect(doc.revisions?.at(-1)).toMatchObject({ rev: "B", drawn: "NS" });
    expect(doc.numbering.rules[0]).toMatchObject({ scope: "page", format: "{page}{prefix}{n}" });
    expect(doc.numbering.closeGapsOnDelete).toBe(false);
    expect(doc.wireNumbering?.format).toBe("{class}{n:4}");
    expect(doc.wireNumbering?.preset).toBe("custom");
    expect(doc.wireNumbering?.classes.map((c) => c.letter)).toEqual(["A", "B"]);
    expect(doc.wiring).toMatchObject({ standard: "nfpa", destination: true });
    expect(doc.styles.text?.componentRef?.size).toBe(12);
    expect(doc.styles.graphics?.wire?.width).toBe(2);
    const txt = settingsText(doc);
    expect(txt).toMatch(/machine = GT-OMNI/);
    expect(txt).toMatch(/A \| .* \| 48 V DC/);
    expect(() => edit(load(), (d) => updateSettings(d, { wireNumbering: { classes: [{ letter: "X", name: "x", kind: "dc" }] } }))).toThrow(/terminal-strip letter/);
    expect(() => edit(load(), (d) => updateSettings(d, { styles: { text: { nope: { size: 1 } } } }))).toThrow(/Unknown text role/);
  });

  it("creates and edits a terminal strip, draws its terminals", () => {
    let doc = edit(load(), (d) => editStrip(d, "X5", { create: { count: 4 } })).doc;
    expect(collectStrips(doc).find((v) => v.tag === "X5")?.rows.length).toBe(4);
    doc = edit(doc, (d) => editStrip(d, "X5", { rows: [{ terminal: "1", type: "pe", bridge: true }, { terminal: "2", partNumber: "2002-1201" }], addSpares: { count: 2 }, description: "Safety", location: "+CAB1" })).doc;
    const v = collectStrips(doc).find((x) => x.tag === "X5")!;
    expect(v.rows.length).toBe(6);
    expect(v.rows[0].type).toBe("pe");
    expect(v.strip?.description).toBe("Safety");
    const placed = edit(doc, (d) => placeStripTerminals(d, "X5", "1", { terminals: ["1", "2", "3"] }));
    doc = placed.doc;
    expect(placed.out).toMatch(/Drew 3 terminals of X5/);
    expect(allElements(doc).filter((x) => /^X5:/.test(x.e.info.label ?? "")).length).toBe(3);
    doc = edit(doc, (d) => editStrip(d, "X5", { rename: "X6", renumber: { start: 10 } })).doc;
    expect(allElements(doc).filter((x) => /^X6:1\d$/.test(x.e.info.label ?? "")).length).toBe(3);
    expect(stripsText(doc, "X6")).toMatch(/X6 — 6 terminals/);
    expect(() => edit(doc, (d) => editStrip(d, "X6", { delete: true }))).toThrow(/still has terminals drawn/);
    expect(() => edit(doc, (d) => editStrip(d, "X6", { removeSpares: ["10"] }))).toThrow(/drawn on sheet/);
  });

  it("builds reports", () => {
    const doc = load();
    const bom = reportTable(doc, "bom");
    expect(bom.rows.length).toBeGreaterThan(0);
    expect(bom.header).toContain("Part number");
    const wl = reportTable(doc, "wire_list", { pages: ["1"] });
    expect(wl.rows.length).toBe(findPage(doc, 1).wires.length);
    expect(reportCsv(wl).split("\r\n")[0]).toContain("Wire,From,To");
    expect(reportTable(doc, "terminal_plan").rows.length).toBe(18);
    expect(reportTable(doc, "cable_list").rows).toEqual([]);
  });
});
