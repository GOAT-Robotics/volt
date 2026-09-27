import { describe, expect, it } from "vitest";
import type { ElementDef, ElemInst, Wire, WireEnd } from "../model";
import { newDoc } from "../doc";
import { computeNets } from "../topology";
import { clearMate, guessGender, matedPinPairs, setMate } from "../mating";
import { toScene, toLocal, elemMatrix, applyMat } from "../geometry";
import { scaleElements } from "../ops";
import { buildXref } from "../xref";
import { approxMeasure } from "../render/svg";

const def = (id: string, name: string, nums: string[]): ElementDef => ({
  id, uuid: id, name, names: { en: name }, width: 20, height: 20, hotspotX: 0, hotspotY: 0, linkType: "simple", prefix: "X", category: "",
  prims: [{ t: "rect", x: 0, y: 0, w: 20, h: 40, rx: 0, ry: 0, style: {} } as never],
  pins: nums.map((n, i) => ({ id: `${id}-${n}`, x: 0, y: i * 10, orient: "w", name: "", number: n })) as ElementDef["pins"],
  info: {}, kind: {}, meta: {},
});
const inst = (id: string, defId: string, x: number, label: string): ElemInst => ({ id, defId, x, y: 0, rot: 0, mirror: false, info: { label }, texts: [] });
const P = (el: string, pin: string): WireEnd => ({ k: "pin", el, pin });

describe("mated connectors", () => {
  it("guesses gender and pairs pins by number", () => {
    expect(guessGender(def("a", "Plug 4 pin", []))).toBe("male");
    expect(guessGender(def("b", "Socket female 4p", []))).toBe("female");
    const pairs = matedPinPairs(def("m", "plug", ["1", "2", "3"]), def("f", "socket", ["3", "1", "2", "4"]));
    expect(pairs.map((p) => [p.a, p.b])).toEqual([["m-1", "f-1"], ["m-2", "f-2"], ["m-3", "f-3"]]);
  });

  it("joins nets through the pair, cross-links the references, unlinks both sides", () => {
    const d = newDoc("t");
    d.defs.m = def("m", "Plug", ["1", "2"]);
    d.defs.f = def("f", "Socket", ["1", "2"]);
    d.defs.r = def("r", "Load", ["1", "2"]);
    const pg = d.pages[0];
    pg.elements.push(inst("M", "m", 100, "X1"), inst("F", "f", 200, "X1F"), inst("A", "r", 0, "Q1"), inst("B", "r", 300, "K1"));
    const w = (id: string, a: WireEnd, b: WireEnd): Wire => ({ id, a, b, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] });
    pg.wires.push(w("w1", P("A", "r-1"), P("M", "m-1")), w("w2", P("F", "f-1"), P("B", "r-1")));
    expect(computeNets(pg, d).length).toBe(2);
    setMate(d, "M", "F", "male");
    expect(pg.elements.find((e) => e.id === "F")!.mate).toEqual({ id: "M", gender: "female" });
    const nets = computeNets(pg, d);
    expect(nets.length).toBe(1);
    expect(nets[0].wires.sort()).toEqual(["w1", "w2"]);
    const x = buildXref(d, approxMeasure);
    const om = x.occ.find((o) => o.id === "M")!, of = x.occ.find((o) => o.id === "F")!;
    expect(om.group).toBeGreaterThanOrEqual(0);
    expect(om.group).toBe(of.group);
    clearMate(d, "F");
    expect(pg.elements.some((e) => e.mate)).toBe(false);
  });
});

describe("component size", () => {
  it("scales around the hotspot, keeps the aspect ratio and wires attached", () => {
    const e = { x: 100, y: 50, rot: 1 as const, mirror: false, scale: 2 };
    const p = toScene(e, { x: 10, y: 5 });
    expect(p).toEqual({ x: 90, y: 70 });
    expect(toLocal(e, p)).toEqual({ x: 10, y: 5 });
    expect(applyMat(elemMatrix(e), { x: 10, y: 5 })).toEqual(p);
    const d = newDoc("t");
    d.defs.r = def("r", "Load", ["1", "2"]);
    const pg = d.pages[0];
    pg.elements.push(inst("A", "r", 0, "Q1"));
    pg.wires.push({ id: "w", a: P("A", "r-2"), b: { k: "free" }, pts: [{ x: 0, y: 10 }, { x: 50, y: 10 }] });
    scaleElements(d, pg, ["A"], (k) => k * 2);
    expect(pg.elements[0].scale).toBe(2);
    expect(pg.wires[0].pts[0]).toEqual({ x: 0, y: 20 });
    scaleElements(d, pg, ["A"], () => 1);
    expect(pg.elements[0].scale).toBeUndefined();
  });
});
