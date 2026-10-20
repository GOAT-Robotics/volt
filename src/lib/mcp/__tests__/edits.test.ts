import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { produce } from "immer";
import { importQet } from "@/core/qet";
import { projectNets } from "@/core/erc";
import type { Doc } from "@/core/model";
import { AddressError, allElements, checksText, componentText, componentsText, findComponent, findComponents, findPage, findPin, findWires, netlistText, overviewText, positionOf, short, withLinkedParts, wiresText } from "../doc";
import { connectPins, deleteComponent, deleteWires, EditError, moveComponent, numberWires, placeComponent, planReferences, applyReferences, renameComponent, setComponentData, setWires } from "../edits";

const FIX = path.join(__dirname, "..", "..", "..", "core", "qet", "__fixtures__", "projects", "2612_ats_singlephase.qet");
const load = (): Doc => importQet(readFileSync(FIX, "utf8"), "ats.qet").doc;
const edit = (doc: Doc, f: (d: Doc) => unknown) => produce(doc, (d: Doc) => void f(d));
const labels = (doc: Doc, l: string) => allElements(doc).filter((x) => x.e.info.label === l);

describe("MCP: reading a drawing", () => {
  const doc = load();

  it("summarises the drawing", () => {
    const t = overviewText(doc);
    expect(t).toContain('Drawing "2612_ATS_SinglePhase"');
    expect(t).toMatch(/1 "Single Phase ATS Schematic" — \d+ components, \d+ wires/);
  });

  it("lists components without splices, contacts named after their device", () => {
    const t = componentsText(doc, { page: findPage(doc, 1) });
    expect(t).toMatch(/^K1 \| 1·/m);
    expect(t).not.toMatch(/\| Splice \[/);
    expect(t).toMatch(/wire splices not listed/);
    expect(t).not.toContain("formula=");
  });

  it("finds pages by number, title and rejects unknown ones", () => {
    expect(findPage(doc, 2).title).toBe("Single Phase ATS Mounting");
    expect(findPage(doc, "three phase ats schematic").title).toBe("Three Phase ATS Schematic");
    expect(() => findPage(doc, 9)).toThrow(AddressError);
  });

  it("addresses device parts and asks when ambiguous", () => {
    expect(findComponents(doc, "K1").length).toBe(2); // K1 on sheet 1 and on sheet 3
    expect(findComponent(doc, "K1@1").page.title).toBe("Single Phase ATS Schematic");
    expect(() => findComponent(doc, "K1")).toThrow(/has 2 parts/);
    const id = labels(doc, "U1")[0].e.id;
    expect(findComponent(doc, short(id)).e.id).toBe(id);
    expect(() => findComponents(doc, "K99")).toThrow(/No component "K99"/);
  });

  it("resolves pins by number, name or position", () => {
    const x = allElements(doc).find((x) => x.page === findPage(doc, 1) && x.def?.pins.some((p) => p.number || p.name))!;
    const pinned = x.def!.pins.find((p) => p.number || p.name)!;
    expect(findPin(doc, `${short(x.e.id)}:${pinned.number || pinned.name}`).pin.id).toBe(pinned.id);
    expect(findPin(doc, "K1@1:p1").pin.id).toBe(findComponent(doc, "K1@1").def!.pins[0].id);
    expect(() => findPin(doc, "K1@1:Z9")).toThrow(/has no pin/);
  });

  it("shows what each pin connects to, the netlist, wires and rule checks", () => {
    const c = componentText(doc, withLinkedParts(doc, findComponents(doc, "U1")));
    expect(c).toMatch(/pin .+: .+—? ?/);
    const n = netlistText(doc);
    expect(n).toMatch(/^\d+ conductors/);
    expect(n).toMatch(/U1:[^@ ]+@1/);
    const w = wiresText(doc, { page: findPage(doc, 1), limit: 5 });
    expect(w.split("\n").length).toBe(7);
    expect(w).toMatch(/#[0-9a-f]{8} \| 1 \| /);
    const ch = checksText(doc);
    expect(ch.text).toMatch(/\d+ errors?, \d+ warnings?/);
  });

  it("turns a border cell into a sheet position", () => {
    const pg = findPage(doc, 1);
    const p = positionOf(doc, pg, { cell: "3C" });
    expect(p.x).toBeGreaterThan(pg.border.colW * 2);
    expect(() => positionOf(doc, pg, { cell: "99Z" })).toThrow(/outside/);
  });
});

describe("MCP: changing a drawing", () => {
  it("renames every part of a device and locks the reference", () => {
    const doc = load();
    const next = edit(doc, (d) => renameComponent(d, "K1", "K21"));
    expect(labels(next, "K1")).toEqual([]);
    expect(labels(next, "K21").length).toBe(2);
    expect(labels(next, "K21").some((x) => x.e.refLocked)).toBe(true);
    expect(labels(doc, "K1").length).toBe(2); // the original is untouched
  });

  it("refuses a reference that is taken", () => {
    expect(() => edit(load(), (d) => renameComponent(d, "K1", "K2"))).toThrow(EditError);
  });

  it("sets and clears component data", () => {
    let doc = edit(load(), (d) => setComponentData(d, "U1@1", { part_number: "SPRO-2", rating: "16 A" }));
    const u1 = findComponent(doc, "U1@1").e;
    expect(u1.info.manufacturer_reference).toBe("SPRO-2");
    expect(u1.info.rating).toBe("16 A");
    doc = edit(doc, (d) => setComponentData(d, "U1@1", { rating: "" }));
    expect(findComponent(doc, "U1@1").e.info.rating).toBeUndefined();
  });

  it("closes gaps in references, device parts together", () => {
    const doc = edit(load(), (d) => renameComponent(d, "K8", "K12"));
    const plan = planReferences(doc, { mode: "close_gaps", prefixes: ["K"] });
    // K12 is locked by the rename, so nothing moves into its place; unlock it and plan again
    const unlocked = edit(doc, (d) => setComponentData(d, "K12", {}, {}, { allParts: true, lockReference: false }));
    const plan2 = planReferences(unlocked, { mode: "close_gaps", prefixes: ["K"] });
    expect(plan.some((c) => c.from === "K12")).toBe(false);
    expect(plan2.some((c) => c.from === "K12" && c.to === "K8")).toBe(true);
  });

  it("renumbers by rules keeping device parts on one reference", () => {
    const doc = load();
    const plan = planReferences(doc, { mode: "by_rules" });
    const next = edit(doc, (d) => applyReferences(d, plan));
    expect(plan.length).toBeGreaterThan(0);
    // every device whose parts shared a reference still shares one (possibly a new one)
    const newOf = new Map(allElements(next).map((x) => [x.e.id, x.e.info.label]));
    const groups = new Map<string, Set<string | undefined>>();
    for (const x of allElements(doc)) if (x.e.info.label && !x.e.info.label.includes(":")) (groups.get(x.e.info.label) ?? groups.set(x.e.info.label, new Set()).get(x.e.info.label)!).add(newOf.get(x.e.id));
    for (const [old, s] of groups) expect([old, s.size]).toEqual([old, 1]);
  });

  it("connects two pins with a routed wire that joins their nets", () => {
    const doc = load();
    const a = findComponent(doc, "K2@1"), b = findComponent(doc, "K3@1");
    let wireId = "";
    const next = edit(doc, (d) => {
      wireId = connectPins(d, "K2@1:p1", "K3@1:p1", { number: "T100" }).wireId;
    });
    const w = findWires(next, short(wireId))[0].w;
    expect(w.label).toBe("T100");
    expect(w.labelLocked).toBe(true);
    const { netOfPin } = projectNets(next);
    expect(netOfPin.get(`${a.e.id}/${a.def!.pins[0].id}`)).toBe(netOfPin.get(`${b.e.id}/${b.def!.pins[0].id}`));
    expect(() => edit(doc, (d) => connectPins(d, "K2@1:p1", "K5:p1"))).toThrow(/on page 1 and K5 on page 3|page/);
  });

  it("sets conductor data and validates it", () => {
    const doc = load();
    const wid = findPage(doc, 1).wires[0].id;
    const next = edit(doc, (d) => setWires(d, [wid], { potential: "DC+", use: "control", colour: "BU", section: "0.75 mm²" }));
    const w = findWires(next, short(wid))[0].w;
    expect([w.pot, w.use, w.insulation, w.section]).toEqual(["DC+", "control", "BU", "0.75 mm²"]);
    expect(() => edit(doc, (d) => setWires(d, [wid], { potential: "24V" }))).toThrow(/potential must be one of/);
  });

  it("numbers wires (plan without applying) and deletes wires", () => {
    const doc = load();
    const plan = numberWires(doc, "all", undefined, false);
    expect(plan.text).toMatch(/circuits, \d+ wires/);
    const wid = findPage(doc, 1).wires[0].id;
    const next = edit(doc, (d) => deleteWires(d, [wid]));
    expect(() => findWires(next, short(wid))).toThrow(AddressError);
  });

  it("places, moves and deletes a component", () => {
    const doc = load();
    const pg = findPage(doc, 1);
    const def = findComponent(doc, "K2@1").def!;
    let next = edit(doc, (d) => placeComponent(d, findPage(d, 1), structuredClone(def), positionOf(d, pg, { cell: "30N" }), { reference: "K30" }));
    const k30 = findComponent(next, "K30");
    expect(k30.page.id).toBe(pg.id);
    next = edit(next, (d) => moveComponent(d, "K30", { dx: 20, dy: 0 }));
    expect(findComponent(next, "K30").e.x).toBe(k30.e.x + 20);
    next = edit(next, (d) => deleteComponent(d, "K30"));
    expect(() => findComponents(next, "K30")).toThrow(AddressError);
    expect(() => edit(doc, (d) => placeComponent(d, findPage(d, 1), structuredClone(def), { x: 100, y: 100 }, { reference: "K2" }))).toThrow(/already used/);
  });
});
