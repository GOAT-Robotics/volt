import { beforeEach, describe, expect, it } from "vitest";
import type { Doc, ElemInst, ElementDef, Page, Pt, Wire } from "../model";
import {
  addWire,
  applyAutoConnections,
  cleanupJunctions,
  copySelection,
  deleteSelection,
  emptySel,
  findAutoConnections,
  mirrorSelection,
  moveSelection,
  newElement,
  pasteClip,
  pinOrientScene,
  reattachEnd,
  rotateSelection,
  type EndTarget,
  type Sel,
} from "../ops";
import { toScene } from "../geometry";
import { computeNets, connectivitySignature, endPoint } from "../topology";
import { autoRoute, isOrthogonal, nearestSegment, simplify } from "../wires";
import { expectWiresConsistent, fourPin, mkDef, mkDoc, near, rng, twoPin } from "./helpers";

let doc: Doc, page: Page, TWO: ElementDef, FOUR: ElementDef;
beforeEach(() => {
  ({ doc, page } = mkDoc(false));
  TWO = twoPin();
  FOUR = fourPin();
});

const place = (def: ElementDef, x: number, y: number, rot: 0 | 1 | 2 | 3 = 0, mirror = false) => newElement(doc, page, def, { x, y }, rot, mirror);
const pinAt = (e: ElemInst, pin: string): Pt => {
  const p = doc.defs[e.defId].pins.find((q) => q.id === pin)!;
  return toScene(e, p);
};
const pinT = (e: ElemInst, pin: string): EndTarget => ({ k: "pin", el: e.id, pin, p: pinAt(e, pin) });
function connect(a: ElemInst, ap: string, b: ElemInst, bp: string): Wire {
  const pts = autoRoute(pinAt(a, ap), pinOrientScene(a, doc.defs[a.defId], ap)!, pinAt(b, bp), pinOrientScene(b, doc.defs[b.defId], bp)!);
  const w = addWire(page, pinT(a, ap), pinT(b, bp), pts);
  expect(w).not.toBeNull();
  return w!;
}
const sel = (s: Partial<Sel>): Sel => ({ ...emptySel(), ...s });
const wireTarget = (w: Wire, p: Pt): EndTarget => {
  const n = nearestSegment(w.pts, p)!;
  expect(n.d).toBeLessThan(0.5);
  return { k: "wire", wire: w.id, seg: n.i, p };
};
/** Point at parameter t (0..1) along the longest segment of a wire (interior point). */
function interiorPoint(w: Wire): Pt {
  let best = 0, bl = -1;
  for (let i = 0; i < w.pts.length - 1; i++) {
    const l = Math.abs(w.pts[i + 1].x - w.pts[i].x) + Math.abs(w.pts[i + 1].y - w.pts[i].y);
    if (l > bl) (bl = l), (best = i);
  }
  const a = w.pts[best], b = w.pts[best + 1];
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
}

describe("newElement", () => {
  it("auto-numbers with the next free reference", () => {
    doc.numbering.autoOnPlace = true;
    const a = place(TWO, 105, 105), b = place(TWO, 205, 105), c = place(TWO, 305, 105);
    expect([a, b, c].map((e) => e.info.label)).toEqual(["K1", "K2", "K3"]);
    deleteSelection(doc, page, sel({ elements: [b.id] }));
    expect(place(TWO, 405, 105).info.label).toBe("K2");
    expect(place(TWO, 505, 105).info.label).toBe("K4");
  });
  it("does not number when auto numbering is off or the element has no pins", () => {
    expect(place(TWO, 105, 105).info.label).toBeUndefined();
    doc.numbering.autoOnPlace = true;
    const nopins = mkDef("deco", [], { prefix: "X" });
    expect(place(nopins, 105, 105).info.label).toBeUndefined();
  });
  it("adds a reference text and registers the definition", () => {
    const e = place(TWO, 105, 105);
    expect(doc.defs[TWO.id]).toBe(TWO);
    expect(e.texts.some((t) => t.info === "label" && t.role === "componentRef")).toBe(true);
    expect(page.elements).toContain(e);
  });
  it("gives every instance a fresh id", () => {
    const ids = new Set(Array.from({ length: 50 }, (_, i) => place(TWO, 105 + i * 10, 105).id));
    expect(ids.size).toBe(50);
  });
});

describe("moveSelection / rotate / mirror keep wires on pins", () => {
  function grid(n: number) {
    const els: ElemInst[] = [];
    for (let i = 0; i < n; i++) els.push(place(i % 2 ? FOUR : TWO, 105 + (i % 5) * 100, 105 + Math.floor(i / 5) * 120, (i % 4) as 0 | 1 | 2 | 3, i % 3 === 0));
    const r = rng(11);
    for (let k = 0; k < n * 1.5; k++) {
      const a = r.pick(els), b = r.pick(els);
      if (a === b) continue;
      connect(a, r.pick(doc.defs[a.defId].pins).id, b, r.pick(doc.defs[b.defId].pins).id);
    }
    return els;
  }

  it("rubber-bands attached wires for random moves of random subsets", () => {
    const els = grid(15);
    expectWiresConsistent(doc, page);
    const r = rng(12);
    for (let step = 0; step < 200; step++) {
      const s = els.filter(() => r.next() < 0.3).map((e) => e.id);
      const d = { x: r.grid(-60, 60, 10), y: r.grid(-60, 60, 10) };
      moveSelection(doc, page, sel({ elements: s }), d);
      expectWiresConsistent(doc, page);
    }
  });

  it("keeps wires attached through rotations and mirroring", () => {
    const els = grid(12);
    const r = rng(13);
    for (let step = 0; step < 100; step++) {
      const s = els.filter(() => r.next() < 0.3).map((e) => e.id);
      if (!s.length) continue;
      const op = r.int(0, 2);
      if (op === 0) rotateSelection(doc, page, sel({ elements: s }), r.next() < 0.5);
      else if (op === 1) mirrorSelection(doc, page, sel({ elements: s }));
      else moveSelection(doc, page, sel({ elements: s }), { x: r.grid(-40, 40, 10), y: r.grid(-40, 40, 10) });
      expectWiresConsistent(doc, page);
    }
  });

  it("translates fully selected wires and junctions with the selection", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305);
    const w = connect(a, "2", b, "1");
    const before = w.pts.map((p) => ({ ...p }));
    moveSelection(doc, page, sel({ elements: [a.id, b.id], wires: [w.id] }), { x: 30, y: -20 });
    expect(page.wires[0].pts).toEqual(before.map((p) => ({ x: p.x + 30, y: p.y - 20 })));
    expectWiresConsistent(doc, page);
  });

  it("moving only a wire attached at both ends moves its interior but keeps its ends on the pins", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305);
    const w = connect(a, "2", b, "1");
    moveSelection(doc, page, sel({ wires: [w.id] }), { x: 20, y: 0 });
    expectWiresConsistent(doc, page);
  });

  it("does not move locked elements", () => {
    const a = place(TWO, 105, 105);
    a.locked = true;
    moveSelection(doc, page, sel({ elements: [a.id] }), { x: 50, y: 50 });
    expect([a.x, a.y]).toEqual([105, 105]);
  });

  it("rotating a single element 4x returns to the start", () => {
    const a = place(FOUR, 205, 205), b = place(TWO, 405, 105);
    connect(a, "e", b, "1");
    for (const cw of [true, false]) {
      for (let i = 0; i < 4; i++) {
        rotateSelection(doc, page, sel({ elements: [a.id] }), cw);
        expectWiresConsistent(doc, page);
      }
      expect({ x: a.x, y: a.y, rot: a.rot }).toEqual({ x: 205, y: 205, rot: 0 });
    }
  });

  it("rotating a multi-element selection 4x (either direction) returns every element to its start", () => {
    // hotspot bbox centre (255, 255) is an exact grid-preserving pivot
    const els = [place(TWO, 105, 105), place(FOUR, 235, 175), place(TWO, 405, 305), place(FOUR, 155, 405)];
    connect(els[0], "2", els[1], "w");
    connect(els[2], "1", els[3], "n");
    const start = els.map((e) => ({ x: e.x, y: e.y, rot: e.rot }));
    for (let i = 0; i < 4; i++) {
      rotateSelection(doc, page, sel({ elements: els.map((e) => e.id) }), true);
      expectWiresConsistent(doc, page);
    }
    expect(els.map((e) => ({ x: e.x, y: e.y, rot: e.rot }))).toEqual(start);
    for (let i = 0; i < 4; i++) rotateSelection(doc, page, sel({ elements: els.map((e) => e.id) }), false);
    expect(els.map((e) => ({ x: e.x, y: e.y, rot: e.rot }))).toEqual(start);
    // a random grid-aligned group whose bbox centre is a grid-preserving pivot
    const r = rng(99);
    for (let k = 0; k < 20; k++) {
      const { doc: d2, page: p2 } = mkDoc();
      const cx = r.grid(105, 505, 10), cy = r.grid(105, 505, 10), hw = r.grid(20, 200, 10), hh = r.grid(20, 200, 10);
      const g = [newElement(d2, p2, TWO, { x: cx - hw, y: cy - hh }), newElement(d2, p2, FOUR, { x: cx + hw, y: cy + hh })];
      for (let i = 0; i < 6; i++) g.push(newElement(d2, p2, TWO, { x: r.grid(cx - hw, cx + hw, 10), y: r.grid(cy - hh, cy + hh, 10) }));
      const s0 = g.map((e) => ({ x: e.x, y: e.y }));
      for (let i = 0; i < 4; i++) rotateSelection(d2, p2, sel({ elements: g.map((e) => e.id) }), true);
      expect(g.map((e) => ({ x: e.x, y: e.y }))).toEqual(s0);
    }
  });

  it("group rotation without an exact pivot keeps elements on the grid and wires attached", () => {
    const els = [place(TWO, 105, 105), place(FOUR, 235, 175), place(TWO, 405, 305), place(FOUR, 155, 455)];
    connect(els[0], "2", els[1], "w");
    for (let i = 0; i < 4; i++) {
      rotateSelection(doc, page, sel({ elements: els.map((e) => e.id) }), true);
      for (const e of els) expect([((e.x - 5) % 10 + 10) % 10, ((e.y - 5) % 10 + 10) % 10]).toEqual([0, 0]);
      expectWiresConsistent(doc, page);
    }
    expect(els.map((e) => e.rot)).toEqual([0, 0, 0, 0]);
  });

  it("rotation about an explicit pivot is exact", () => {
    const a = place(TWO, 105, 105);
    rotateSelection(doc, page, sel({ elements: [a.id] }), true, { x: 205, y: 205 });
    expect({ x: a.x, y: a.y, rot: a.rot }).toEqual({ x: 305, y: 105, rot: 1 });
  });

  it("mirroring twice restores the elements", () => {
    const els = [place(TWO, 105, 105), place(FOUR, 255, 175)];
    connect(els[0], "2", els[1], "w");
    const start = els.map((e) => ({ x: e.x, y: e.y, m: e.mirror }));
    mirrorSelection(doc, page, sel({ elements: els.map((e) => e.id) }));
    expectWiresConsistent(doc, page);
    mirrorSelection(doc, page, sel({ elements: els.map((e) => e.id) }));
    expect(els.map((e) => ({ x: e.x, y: e.y, m: e.mirror }))).toEqual(start);
    expectWiresConsistent(doc, page);
  });
});

describe("addWire", () => {
  it("pin → pin", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305);
    const w = connect(a, "2", b, "1");
    expect(w.a).toEqual({ k: "pin", el: a.id, pin: "2" });
    expect(w.b).toEqual({ k: "pin", el: b.id, pin: "1" });
    expectWiresConsistent(doc, page);
    expect(connectivitySignature(page)).toEqual([[`${a.id}/2`, `${b.id}/1`].sort().join("|")]);
  });

  it("pin → wire creates a junction and splits the host wire preserving its geometry", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 505, 405), c = place(TWO, 305, 605);
    const host = connect(a, "2", b, "1");
    const hostPts = host.pts.map((p) => ({ ...p }));
    const p = interiorPoint(host);
    const w = addWire(page, pinT(c, "1"), wireTarget(host, p), [pinAt(c, "1"), { x: pinAt(c, "1").x, y: p.y }, p])!;
    expect(w).not.toBeNull();
    expect(page.junctions).toHaveLength(1);
    const j = page.junctions[0];
    expect({ x: j.x, y: j.y }).toEqual(p);
    expect(w.b).toEqual({ k: "junction", j: j.id });
    expect(page.wires).toHaveLength(3);
    // the two halves together reproduce the host geometry
    const halves = page.wires.filter((x) => x.id !== w.id);
    const h1 = halves.find((x) => x.a.k === "pin" && x.a.el === a.id)!;
    const h2 = halves.find((x) => x.b.k === "pin" && x.b.el === b.id)!;
    expect(h1.b).toEqual({ k: "junction", j: j.id });
    expect(h2.a).toEqual({ k: "junction", j: j.id });
    expect(simplify([...h1.pts, ...h2.pts.slice(1)])).toEqual(simplify(hostPts));
    expectWiresConsistent(doc, page);
    const nets = computeNets(page);
    expect(nets).toHaveLength(1);
    expect(nets[0].pins).toHaveLength(3);
  });

  it("pin → free leaves a dangling end", () => {
    const a = place(TWO, 105, 105);
    const start = pinAt(a, "2");
    const w = addWire(page, pinT(a, "2"), { k: "free", p: { x: 105, y: 305 } }, [start, { x: 105, y: 305 }])!;
    expect(w.b).toEqual({ k: "free" });
    expect(w.pts[w.pts.length - 1]).toEqual({ x: 105, y: 305 });
    expect(page.junctions).toHaveLength(0);
  });

  it("wire → wire on the same wire creates two junctions", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 705, 105);
    const host = connect(a, "2", b, "1");
    const hostPts = simplify(host.pts);
    // host: vertical stub down, horizontal run, stub up — pick two points on the horizontal run
    const run = hostPts.findIndex((p, i) => i < hostPts.length - 1 && p.y === hostPts[i + 1].y && Math.abs(hostPts[i + 1].x - p.x) > 100);
    expect(run).toBeGreaterThanOrEqual(0);
    const y = hostPts[run].y;
    const x0 = Math.min(hostPts[run].x, hostPts[run + 1].x);
    const p1 = { x: x0 + 40, y }, p2 = { x: x0 + 140, y };
    const w = addWire(page, wireTarget(host, p1), wireTarget(host, p2), [p1, { x: p1.x, y: y + 60 }, { x: p2.x, y: y + 60 }, p2])!;
    expect(w).not.toBeNull();
    expect(page.junctions).toHaveLength(2);
    expect(page.wires).toHaveLength(4);
    expect(w.a.k).toBe("junction");
    expect(w.b.k).toBe("junction");
    expect(w.a).not.toEqual(w.b);
    expectWiresConsistent(doc, page);
    expect(computeNets(page)).toHaveLength(1);
  });

  it("joining another wire's free end merges into one wire", () => {
    const a = place(TWO, 105, 105), c = place(TWO, 305, 505);
    const free = addWire(page, pinT(a, "2"), { k: "free", p: { x: 105, y: 305 } }, [pinAt(a, "2"), { x: 105, y: 305 }])!;
    const cp = pinAt(c, "1");
    const w = addWire(page, pinT(c, "1"), { k: "wireEnd", wire: free.id, end: "b", p: { x: 105, y: 305 } }, [cp, { x: cp.x, y: 305 }, { x: 105, y: 305 }]);
    expect(w).not.toBeNull();
    expect(page.junctions).toHaveLength(0);
    expect(page.wires).toHaveLength(1);
    const m = page.wires[0];
    const ends = [m.a, m.b].map((e) => (e.k === "pin" ? e.el + "/" + e.pin : e.k)).sort();
    expect(ends).toEqual([`${a.id}/2`, `${c.id}/1`].sort());
    expectWiresConsistent(doc, page);
  });

  it("joining a wire end that is attached reuses that attachment", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305), c = place(TWO, 505, 505);
    const w1 = connect(a, "2", b, "1");
    const bp = pinAt(b, "1");
    const cp = pinAt(c, "1");
    const w = addWire(page, pinT(c, "1"), { k: "wireEnd", wire: w1.id, end: "b", p: bp }, [cp, { x: cp.x, y: bp.y }, bp])!;
    expect(w.b).toEqual({ k: "pin", el: b.id, pin: "1" });
  });

  it("rejects zero-length and self-loop wires", () => {
    const a = place(TWO, 105, 105);
    const p = pinAt(a, "2");
    expect(addWire(page, pinT(a, "2"), { k: "free", p }, [p, p])).toBeNull();
    expect(addWire(page, pinT(a, "2"), pinT(a, "2"), [p, { x: p.x, y: p.y + 20 }, p])).toBeNull();
    expect(page.wires).toHaveLength(0);
  });

  it("crossing wires never connect", () => {
    const n = place(TWO, 305, 105), s = place(TWO, 305, 505), w = place(FOUR, 105, 305), e = place(FOUR, 505, 305);
    const v = addWire(page, pinT(n, "2"), pinT(s, "1"), [pinAt(n, "2"), pinAt(s, "1")])!;
    const h = addWire(page, pinT(w, "e"), pinT(e, "w"), [pinAt(w, "e"), pinAt(e, "w")])!;
    expect(v && h).toBeTruthy();
    expect(page.junctions).toHaveLength(0);
    const nets = computeNets(page);
    expect(nets).toHaveLength(2);
    expect(nets.every((n) => n.pins.length === 2)).toBe(true);
  });
});

describe("deleteSelection & junction cleanup", () => {
  function tee() {
    const a = place(TWO, 105, 105), b = place(TWO, 505, 405), c = place(TWO, 305, 605);
    const host = connect(a, "2", b, "1");
    const hostPts = simplify(host.pts.map((p) => ({ ...p })));
    const p = interiorPoint(host);
    const cp = pinAt(c, "1");
    const branch = addWire(page, pinT(c, "1"), wireTarget(host, p), [cp, { x: cp.x, y: p.y }, p])!;
    return { a, b, c, hostPts, branch, p };
  }

  it("deleting an element keeps its wires in place with dangling ends", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305), c = place(TWO, 505, 505);
    const ab = connect(a, "2", b, "1");
    const pts = ab.pts.map((q) => ({ ...q }));
    const keep = connect(b, "2", c, "1");
    deleteSelection(doc, page, sel({ elements: [a.id] }));
    expect(page.elements.map((e) => e.id)).toEqual([b.id, c.id]);
    expect(page.wires.map((w) => w.id)).toEqual([ab.id, keep.id]);
    const w = page.wires[0];
    expect(w.a).toEqual({ k: "free" });
    expect(w.b).toEqual({ k: "pin", el: b.id, pin: "1" });
    expect(w.pts).toEqual(pts);
  });

  it("deleting the branch component keeps the branch wire and the junction", () => {
    const { a, b, c, branch } = tee();
    deleteSelection(doc, page, sel({ elements: [c.id] }));
    expect(page.junctions).toHaveLength(1);
    expect(page.wires).toHaveLength(3);
    const br = page.wires.find((w) => w.id === branch.id)!;
    expect(br.a).toEqual({ k: "free" });
    void a;
    void b;
  });

  it("degree-2 junction merge after deleting the branch wire", () => {
    const { a, b, hostPts, branch } = tee();
    deleteSelection(doc, page, sel({ wires: [branch.id] }));
    expect(page.junctions).toHaveLength(0);
    expect(page.wires).toHaveLength(1);
    expect(page.wires[0].pts).toEqual(hostPts);
    expect(page.wires[0].a).toEqual({ k: "pin", el: a.id, pin: "2" });
    expect(page.wires[0].b).toEqual({ k: "pin", el: b.id, pin: "1" });
  });

  it("degree-1 junction is removed and the remaining end is freed", () => {
    const { a, b, p, branch } = tee();
    const remaining = page.wires.find((w) => w.a.k === "pin" && w.a.el === a.id)!;
    const toB = page.wires.find((w) => w.b.k === "pin" && w.b.el === b.id)!;
    const pts = remaining.pts.map((q) => ({ ...q }));
    deleteSelection(doc, page, sel({ wires: [toB.id, branch.id] }));
    expect(page.junctions).toHaveLength(0);
    expect(page.wires).toHaveLength(1);
    expect(page.wires[0].b).toEqual({ k: "free" });
    expect(page.wires[0].pts).toEqual(pts);
    expect(page.wires[0].pts[page.wires[0].pts.length - 1]).toEqual(p);
  });

  it("deleting a junction frees its wires' ends", () => {
    const { p } = tee();
    const j = page.junctions[0];
    deleteSelection(doc, page, sel({ junctions: [j.id] }));
    expect(page.junctions).toHaveLength(0);
    expect(page.wires).toHaveLength(3);
    const freeEnds = page.wires.flatMap((w) => (["a", "b"] as const).filter((k) => w[k].k === "free").map((k) => (k === "a" ? w.pts[0] : w.pts[w.pts.length - 1])));
    expect(freeEnds).toHaveLength(3);
    for (const q of freeEnds) expect(q).toEqual(p);
  });

  it("does not delete locked elements", () => {
    const a = place(TWO, 105, 105);
    a.locked = true;
    deleteSelection(doc, page, sel({ elements: [a.id] }));
    expect(page.elements).toHaveLength(1);
  });

  it("a chain of degree-2 junctions collapses into one wire with the chained geometry", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 105, 705);
    const pa = pinAt(a, "2"), pb = pinAt(b, "1");
    const n = 6;
    const ys = Array.from({ length: n }, (_, i) => pa.y + ((pb.y - pa.y) * (i + 1)) / (n + 1));
    page.junctions = ys.map((y, i) => ({ id: `j${i}`, x: i % 2 ? 205 : pa.x, y }));
    const nodes: { end: Wire["a"]; p: Pt }[] = [
      { end: { k: "pin", el: a.id, pin: "2" }, p: pa },
      ...page.junctions.map((j) => ({ end: { k: "junction", j: j.id } as Wire["a"], p: { x: j.x, y: j.y } })),
      { end: { k: "pin", el: b.id, pin: "1" }, p: pb },
    ];
    const expected: Pt[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const p = nodes[i].p, q = nodes[i + 1].p;
      const pts = [p, { x: p.x, y: q.y }, q];
      // alternate the stored direction so the merge has to reverse some pieces
      page.wires.push({ id: `c${i}`, a: i % 2 ? nodes[i + 1].end : nodes[i].end, b: i % 2 ? nodes[i].end : nodes[i + 1].end, pts: i % 2 ? [...pts].reverse() : pts });
      expected.push(...(i ? pts.slice(1) : pts));
    }
    cleanupJunctions(page);
    expect(page.junctions).toHaveLength(0);
    expect(page.wires).toHaveLength(1);
    const w = page.wires[0];
    const fwd = w.a.k === "pin" && w.a.el === a.id ? w.pts : [...w.pts].reverse();
    expect(fwd).toEqual(simplify(expected));
    expect([w.a, w.b].map((e) => (e.k === "pin" ? e.el : e.k)).sort()).toEqual([a.id, b.id].sort());
    expectWiresConsistent(doc, page);
  });

  it("cleanupJunctions leaves degree ≥ 3 junctions alone", () => {
    tee();
    cleanupJunctions(page);
    expect(page.junctions).toHaveLength(1);
    expect(page.wires).toHaveLength(3);
  });
});

describe("reattachEnd", () => {
  it("moves a wire end to another pin and keeps the geometry on the pin", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305), c = place(TWO, 505, 205);
    const w = connect(a, "2", b, "1");
    reattachEnd(doc, page, w.id, "b", pinT(c, "1"));
    const w2 = page.wires.find((x) => x.id === w.id)!;
    expect(w2.b).toEqual({ k: "pin", el: c.id, pin: "1" });
    expect(w2.a).toEqual({ k: "pin", el: a.id, pin: "2" });
    expect(isOrthogonal(w2.pts)).toBe(true);
    expectWiresConsistent(doc, page);
  });
  it("reattaching onto a wire creates a junction", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 505, 405), c = place(TWO, 305, 705);
    const host = connect(a, "2", b, "1");
    const w = addWire(page, pinT(c, "1"), { k: "free", p: { x: 305, y: 655 } }, [pinAt(c, "1"), { x: 305, y: 655 }])!;
    const p = interiorPoint(host);
    reattachEnd(doc, page, w.id, "b", wireTarget(host, p));
    const w2 = page.wires.find((x) => x.id === w.id)!;
    expect(w2.b.k).toBe("junction");
    expect(page.junctions).toHaveLength(1);
    expectWiresConsistent(doc, page);
    expect(computeNets(page)).toHaveLength(1);
  });
  it("detaching to free space frees the end", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305);
    const w = connect(a, "2", b, "1");
    reattachEnd(doc, page, w.id, "b", { k: "free", p: { x: 405, y: 405 } });
    expect(page.wires[0].b).toEqual({ k: "free" });
    expect(page.wires[0].pts[page.wires[0].pts.length - 1]).toEqual({ x: 405, y: 405 });
  });
});

describe("auto connections", () => {
  it("finds free wire ends lying on unconnected pins and applies them", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305);
    const bp = pinAt(b, "1");
    const w = addWire(page, pinT(a, "2"), { k: "free", p: bp }, [pinAt(a, "2"), { x: 105, y: bp.y }, bp])!;
    const found = findAutoConnections(doc, page, [b.id]);
    expect(found).toEqual([{ el: b.id, pin: "1", wire: w.id, end: "b", p: bp }]);
    applyAutoConnections(page, found);
    expect(page.wires[0].b).toEqual({ k: "pin", el: b.id, pin: "1" });
    expect(findAutoConnections(doc, page, [b.id])).toEqual([]);
  });
  it("finds a match after moving an element onto a dangling end", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 505, 505);
    addWire(page, pinT(a, "2"), { k: "free", p: { x: 105, y: 285 } }, [pinAt(a, "2"), { x: 105, y: 285 }]);
    expect(findAutoConnections(doc, page, [b.id])).toEqual([]);
    moveSelection(doc, page, sel({ elements: [b.id] }), { x: -400, y: -200 }); // b pin 1 → (105, 285)
    const found = findAutoConnections(doc, page, [b.id]);
    expect(found).toHaveLength(1);
    expect(found[0].pin).toBe("1");
  });
  it("ignores pins that are already connected", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305);
    connect(a, "2", b, "1");
    const bp = pinAt(b, "1");
    addWire(page, { k: "free", p: { x: 505, y: bp.y } }, { k: "free", p: bp }, [{ x: 505, y: bp.y }, bp]);
    expect(findAutoConnections(doc, page, [b.id])).toEqual([]);
  });
});

describe("copySelection / pasteClip", () => {
  it("fresh ids, internal connections kept, external ones freed", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305), c = place(TWO, 505, 505);
    const inner = connect(a, "2", b, "1");
    const outer = connect(b, "2", c, "1");
    const clip = copySelection(doc, page, sel({ elements: [a.id, b.id], wires: [outer.id] }));
    expect(clip.wires.map((w) => w.id).sort()).toEqual([inner.id, outer.id].sort());
    const before = { e: page.elements.length, w: page.wires.length };
    const s = pasteClip(doc, page, clip, { x: 1000, y: 0 }, false);
    expect(page.elements.length).toBe(before.e + 2);
    expect(page.wires.length).toBe(before.w + 2);
    const oldIds = new Set([a.id, b.id, c.id, inner.id, outer.id]);
    for (const id of [...s.elements, ...s.wires]) expect(oldIds.has(id)).toBe(false);
    const newEls = new Set(s.elements);
    const pw = page.wires.filter((w) => s.wires.includes(w.id));
    const pInner = pw.find((w) => w.a.k === "pin" && w.b.k === "pin")!;
    expect(pInner).toBeDefined();
    expect(newEls.has((pInner.a as { el: string }).el) && newEls.has((pInner.b as { el: string }).el)).toBe(true);
    const pOuter = pw.find((w) => w !== pInner)!;
    expect(pOuter.b).toEqual({ k: "free" });
    expect(pOuter.a.k === "pin" && newEls.has(pOuter.a.el)).toBe(true);
    expectWiresConsistent(doc, page);
    // originals untouched
    expect(page.wires.find((w) => w.id === outer.id)!.b).toEqual({ k: "pin", el: c.id, pin: "1" });
    // texts get fresh ids too
    const origTextIds = new Set([a, b].flatMap((e) => e.texts.map((t) => t.id)));
    for (const e of page.elements.filter((x) => newEls.has(x.id))) for (const t of e.texts) expect(origTextIds.has(t.id)).toBe(false);
  });
  it("does not copy wires that leave the selection unless selected", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 305, 305);
    connect(a, "2", b, "1");
    const clip = copySelection(doc, page, sel({ elements: [a.id] }));
    expect(clip.wires).toHaveLength(0);
  });
  it("copied junctions keep the internal topology", () => {
    const a = place(TWO, 105, 105), b = place(TWO, 505, 405), c = place(TWO, 305, 605);
    const host = connect(a, "2", b, "1");
    const p = interiorPoint(host);
    const cp = pinAt(c, "1");
    addWire(page, pinT(c, "1"), wireTarget(host, p), [cp, { x: cp.x, y: p.y }, p]);
    const all = sel({ elements: [a.id, b.id, c.id], junctions: page.junctions.map((j) => j.id) });
    const sigBefore = connectivitySignature(page).length;
    const s = pasteClip(doc, page, copySelection(doc, page, all), { x: 0, y: 1000 }, false);
    expect(s.junctions).toHaveLength(1);
    expect(s.wires).toHaveLength(3);
    expect(connectivitySignature(page).length).toBe(sigBefore * 2);
    expectWiresConsistent(doc, page);
  });
  it("renumbers pasted elements when auto numbering is on", () => {
    doc.numbering.autoOnPlace = true;
    const a = place(TWO, 105, 105);
    const s = pasteClip(doc, page, copySelection(doc, page, sel({ elements: [a.id] })), { x: 100, y: 0 });
    const n = page.elements.find((e) => e.id === s.elements[0])!;
    expect(a.info.label).toBe("K1");
    expect(n.info.label).toBe("K2");
  });
});

describe("endPoint", () => {
  it("returns null for dangling references", () => {
    expect(endPoint(doc, page, { k: "pin", el: "nope", pin: "1" })).toBeNull();
    expect(endPoint(doc, page, { k: "junction", j: "nope" })).toBeNull();
    expect(endPoint(doc, page, { k: "free" })).toBeNull();
  });
  it("uses the pin scene position", () => {
    const a = place(TWO, 105, 105, 1, true);
    expect(near(endPoint(doc, page, { k: "pin", el: a.id, pin: "1" })!, toScene(a, TWO.pins[0]))).toBe(true);
  });
});
