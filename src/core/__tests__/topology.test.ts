import { describe, expect, it } from "vitest";
import type { Page, Wire, WireEnd } from "../model";
import { newPage } from "../doc";
import { computeNets, connectivityDiff, connectivitySignature, endKey, wiresOfElement, wiresOfJunction } from "../topology";

const P = (el: string, pin: string): WireEnd => ({ k: "pin", el, pin });
const J = (j: string): WireEnd => ({ k: "junction", j });
const F: WireEnd = { k: "free" };
let n = 0;
const W = (a: WireEnd, b: WireEnd): Wire => ({ id: `w${++n}`, a, b, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
function pageWith(wires: Wire[], junctions: string[] = []): Page {
  const p = newPage(0);
  p.wires = wires;
  p.junctions = junctions.map((id) => ({ id, x: 0, y: 0 }));
  return p;
}
const pinSet = (net: { pins: { el: string; pin: string }[] }) => net.pins.map((p) => `${p.el}/${p.pin}`).sort();

describe("computeNets", () => {
  it("includes every pin of a simple two-pin net", () => {
    const nets = computeNets(pageWith([W(P("A", "1"), P("B", "1"))]));
    expect(nets).toHaveLength(1);
    expect(pinSet(nets[0])).toEqual(["A/1", "B/1"]);
  });

  it("merges nets through junctions and chains", () => {
    const page = pageWith(
      [W(P("A", "1"), J("j1")), W(J("j1"), P("B", "1")), W(J("j1"), P("C", "2")), W(P("C", "2"), P("D", "1")), W(P("X", "1"), P("Y", "1"))],
      ["j1"],
    );
    const nets = computeNets(page).sort((a, b) => b.pins.length - a.pins.length);
    expect(nets).toHaveLength(2);
    expect(pinSet(nets[0])).toEqual(["A/1", "B/1", "C/2", "D/1"]);
    expect(nets[0].junctions).toEqual(["j1"]);
    expect(nets[0].wires).toHaveLength(4);
    expect(pinSet(nets[1])).toEqual(["X/1", "Y/1"]);
  });

  it("each pin / junction appears in exactly one net, each wire exactly once", () => {
    const wires: Wire[] = [];
    for (let i = 0; i < 60; i++) wires.push(W(P(`E${i % 17}`, String(i % 3)), i % 5 ? P(`E${(i * 7) % 17}`, String((i + 1) % 3)) : J(`j${i % 4}`)));
    const page = pageWith(wires, ["j0", "j1", "j2", "j3"]);
    const nets = computeNets(page);
    const pins = nets.flatMap(pinSet);
    expect(new Set(pins).size).toBe(pins.length);
    const expectedPins = new Set(wires.flatMap((w) => [w.a, w.b]).filter((e) => e.k === "pin").map((e) => endKey(e)!.slice(2)));
    expect(new Set(pins)).toEqual(expectedPins);
    expect(nets.flatMap((x) => x.wires).sort()).toEqual(wires.map((w) => w.id).sort());
    const js = nets.flatMap((x) => x.junctions);
    expect(new Set(js).size).toBe(js.length);
  });

  it("free-ended wires form their own net; geometric crossings do not connect", () => {
    const a = W(P("A", "1"), F), b = W(F, P("B", "1"));
    a.pts = [{ x: 0, y: 50 }, { x: 100, y: 50 }];
    b.pts = [{ x: 50, y: 0 }, { x: 50, y: 100 }];
    const nets = computeNets(pageWith([a, b]));
    expect(nets).toHaveLength(2);
  });

  it("is independent of wire order", () => {
    const ws = [W(P("A", "1"), J("j")), W(J("j"), P("B", "1")), W(J("j"), P("C", "1")), W(P("D", "1"), P("E", "1"))];
    const s1 = connectivitySignature(pageWith(ws, ["j"]));
    const s2 = connectivitySignature(pageWith([...ws].reverse(), ["j"]));
    expect(s1).toEqual(s2);
    expect(s1).toEqual(["A/1|B/1|C/1", "D/1|E/1"]);
  });
});

describe("connectivitySignature / connectivityDiff", () => {
  it("ignores single-pin nets and geometry", () => {
    const w = W(P("A", "1"), F);
    expect(connectivitySignature(pageWith([w]))).toEqual([]);
    const x = W(P("A", "1"), P("B", "2"));
    const y = { ...x, pts: [{ x: 0, y: 0 }, { x: 0, y: 99 }] };
    expect(connectivitySignature(pageWith([x]))).toEqual(connectivitySignature(pageWith([y])));
  });
  it("reports added / removed connections", () => {
    const before = pageWith([W(P("A", "1"), P("B", "1")), W(P("C", "1"), P("D", "1"))]);
    const after = pageWith([W(P("A", "1"), P("B", "1")), W(P("C", "1"), P("E", "1"))]);
    expect(connectivityDiff(before, after)).toEqual({ added: ["C/1|E/1"], removed: ["C/1|D/1"] });
    expect(connectivityDiff(before, before)).toEqual({ added: [], removed: [] });
  });
  it("detects a net being joined through a junction", () => {
    const before = pageWith([W(P("A", "1"), J("j")), W(J("j"), P("B", "1")), W(P("C", "1"), P("D", "1"))], ["j"]);
    const after = pageWith([W(P("A", "1"), J("j")), W(J("j"), P("B", "1")), W(J("j"), P("C", "1")), W(P("C", "1"), P("D", "1"))], ["j"]);
    const d = connectivityDiff(before, after);
    expect(d.added).toEqual(["A/1|B/1|C/1|D/1"]);
    expect(d.removed.sort()).toEqual(["A/1|B/1", "C/1|D/1"]);
  });
});

describe("wiresOfElement / wiresOfJunction", () => {
  it("lists attachments with their end", () => {
    const w1 = W(P("A", "1"), J("j")), w2 = W(J("j"), P("A", "2"));
    const page = pageWith([w1, w2], ["j"]);
    expect(wiresOfElement(page, "A").map((x) => [x.w.id, x.end])).toEqual([[w1.id, "a"], [w2.id, "b"]]);
    expect(wiresOfJunction(page, "j").map((x) => [x.w.id, x.end])).toEqual([[w1.id, "b"], [w2.id, "a"]]);
  });
});
