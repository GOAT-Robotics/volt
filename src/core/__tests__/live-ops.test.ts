import { describe, expect, it } from "vitest";
import { enablePatches, produceWithPatches, produce, setAutoFreeze } from "immer";
import { applyOps, diffOps, opKey, overlaps } from "../live-ops";

enablePatches();
setAutoFreeze(false);

type D = { pages: { id: string; order: number; elements: { id: string; x: number; y: number; info: Record<string, string> }[]; wires: { id: string; pts: { x: number; y: number }[] }[] }[]; defs: Record<string, { name: string }> };
const base = (): D => ({
  pages: [
    { id: "p1", order: 0, elements: [{ id: "a", x: 0, y: 0, info: {} }, { id: "b", x: 10, y: 0, info: { label: "K1" } }], wires: [{ id: "w", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] },
    { id: "p2", order: 1, elements: [], wires: [] },
  ],
  defs: {},
});
/** Apply a local change, convert to ops, replay the ops on another copy: both must match. */
function roundTrip(start: D, fn: (d: D) => void) {
  const [next] = produceWithPatches(start, fn);
  const ops = diffOps(start, next);
  const replay = produce(start, (d) => applyOps(d, ops));
  expect(replay).toEqual(next);
  const inv = diffOps(next, start);
  expect(produce(next, (d) => applyOps(d, inv))).toEqual(start);
  return { next, ops };
}

describe("live ops", () => {
  it("addresses objects by id", () => {
    const { ops } = roundTrip(base(), (d) => void (d.pages[0].elements[1].x = 50));
    expect(ops).toEqual([{ t: "set", path: ["pages", { id: "p1" }, "elements", { id: "b" }, "x"], value: 50 }]);
  });
  it("inserts, deletes, reorders and edits nested plain arrays", () => {
    roundTrip(base(), (d) => {
      d.pages[0].elements.splice(1, 0, { id: "c", x: 5, y: 5, info: {} });
      d.pages[0].elements = d.pages[0].elements.filter((e) => e.id !== "a");
      d.pages[0].wires[0].pts.push({ x: 20, y: 0 });
      d.pages[1].elements.push({ id: "z", x: 1, y: 1, info: {} });
      d.defs["lib:x"] = { name: "X" };
      delete d.pages[0].elements[1].info.label;
    });
    const { ops } = roundTrip(base(), (d) => void d.pages[0].wires[0].pts.splice(0, 1, { x: 1, y: 1 }));
    expect(ops).toEqual([{ t: "set", path: ["pages", { id: "p1" }, "wires", { id: "w" }, "pts"], value: [{ x: 1, y: 1 }, { x: 10, y: 0 }] }]);
  });
  it("concurrent edits by index-independent ops converge", () => {
    const s = base();
    // user A moves b; user B deletes a (which shifts b's index) at the same time
    const [na] = produceWithPatches(s, (d) => void (d.pages[0].elements[1].x = 99));
    const [nb] = produceWithPatches(s, (d) => void d.pages[0].elements.splice(0, 1));
    const A = diffOps(s, na), B = diffOps(s, nb);
    const serverOrder = produce(s, (d) => (applyOps(d, B), applyOps(d, A)));
    expect(serverOrder.pages[0].elements).toEqual([{ id: "b", x: 99, y: 0, info: { label: "K1" } }]);
    // an op on an element someone deleted is dropped quietly
    const [nc] = produceWithPatches(s, (d) => void (d.pages[0].elements[0].x = 7));
    const C = diffOps(s, nc);
    expect(produce(serverOrder, (d) => applyOps(d, C))).toEqual(serverOrder);
  });
  it("moves inside an id array", () => {
    roundTrip(base(), (d) => void d.pages.reverse());
    roundTrip(base(), (d) => {
      const [a, b] = d.pages[0].elements;
      d.pages[0].elements = [b, a];
      d.pages[0].elements[0].x = 3;
    });
  });
  it("conflict keys", () => {
    const k = opKey({ t: "set", path: ["pages", { id: "p1" }, "elements", { id: "b" }], value: {} });
    expect(overlaps(k, "pages/#p1/elements/#b/x")).toBe(true);
    expect(overlaps(k, "pages/#p1/elements/#bb")).toBe(false);
  });
});
