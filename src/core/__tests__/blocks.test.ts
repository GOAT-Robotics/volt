import { beforeEach, describe, expect, it } from "vitest";
import type { BlockContent, Doc, ElemInst, ElementDef, Page } from "../model";
import { buildBlock, detachGroup, groupSelection, mergeToDef, placeBlock, updateBlockInstance } from "../blocks";
import { addWire, emptySel, newElement, pinOrientScene, type EndTarget } from "../ops";
import { rotOrient, toScene } from "../geometry";
import { autoRoute } from "../wires";
import { computeNets } from "../topology";
import { expectWiresConsistent, fourPin, mkDoc, twoPin } from "./helpers";

let doc: Doc, page: Page, TWO: ElementDef, FOUR: ElementDef;
beforeEach(() => {
  ({ doc, page } = mkDoc(false));
  TWO = twoPin("relay");
  FOUR = fourPin("term", { prefix: "X" });
});
const pinAt = (e: ElemInst, pin: string) => toScene(e, doc.defs[e.defId].pins.find((p) => p.id === pin)!);
const T = (e: ElemInst, pin: string): EndTarget => ({ k: "pin", el: e.id, pin, p: pinAt(e, pin) });
const connect = (a: ElemInst, ap: string, b: ElemInst, bp: string) =>
  addWire(page, T(a, ap), T(b, bp), autoRoute(pinAt(a, ap), pinOrientScene(a, doc.defs[a.defId], ap)!, pinAt(b, bp), pinOrientScene(b, doc.defs[b.defId], bp)!))!;

/** Source circuit: A —— B internally, X (outside) wired to A.1 */
function source() {
  const a = newElement(doc, page, TWO, { x: 105, y: 105 });
  const b = newElement(doc, page, FOUR, { x: 205, y: 205 });
  const x = newElement(doc, page, TWO, { x: 505, y: 105 });
  a.info.label = "K1";
  b.info.label = "X1";
  x.info.label = "K9";
  const inner = connect(a, "2", b, "w");
  connect(x, "1", a, "1");
  return { a, b, x, inner };
}

describe("buildBlock", () => {
  it("makes content relative to the snapped bbox origin and suggests ports", () => {
    const { a, b, inner } = source();
    const { content, ports } = buildBlock(doc, page, { ...emptySel(), elements: [a.id, b.id], wires: [inner.id] });
    expect(content.elements).toHaveLength(2);
    expect(content.wires).toHaveLength(1);
    expect(content.bbox.x).toBe(0);
    // coordinates are shifted by a grid point
    const dx = a.x - content.elements[0].x, dy = a.y - content.elements[0].y;
    expect(((dx - 5) % 10 + 10) % 10).toBe(0);
    expect(((dy - 5) % 10 + 10) % 10).toBe(0);
    expect(content.wires[0].pts[0]).toEqual({ x: inner.pts[0].x - dx, y: inner.pts[0].y - dy });
    // A.1 is wired outside; B's three unused pins are unconnected → ports. A.2/B.w are internal.
    const names = ports.map((p) => `${p.el}/${p.pin}`).sort();
    expect(names).toEqual([`${a.id}/1`, `${b.id}/e`, `${b.id}/n`, `${b.id}/s`].sort());
    const pa = ports.find((p) => p.el === a.id)!;
    expect({ x: pa.x + dx, y: pa.y + dy }).toEqual(pinAt(a, "1"));
    expect(content.ports).toHaveLength(4);
  });
});

describe("placeBlock / updateBlockInstance", () => {
  function placed(mode: "linked" | "derived" | "independent") {
    const { a, b, inner } = source();
    const { content } = buildBlock(doc, page, { ...emptySel(), elements: [a.id, b.id], wires: [inner.id] });
    const at = { x: 1000, y: 500 };
    const sel = placeBlock(doc, page, "blk1", 1, "Motor starter", content, at, mode);
    const inst = sel.elements.map((id) => page.elements.find((e) => e.id === id)!);
    return { content, sel, inst, at };
  }

  it("independent placement has no group; linked placement tags every item", () => {
    let r = placed("independent");
    expect(r.inst.every((e) => !e.group)).toBe(true);
    ({ doc, page } = mkDoc(false));
    r = placed("linked");
    const g = r.inst[0].group!;
    expect(g).toMatchObject({ blockId: "blk1", revision: 1, mode: "linked", name: "Motor starter", origin: r.at });
    expect(r.inst.every((e) => e.group!.id === g.id)).toBe(true);
    expect(page.wires.filter((w) => w.group?.id === g.id)).toHaveLength(1);
    expect(r.inst.map((e) => e.group!.src)).toEqual(r.content.elements.map((e) => e.id));
    const gs = groupSelection(page, g.id);
    expect(gs.elements.sort()).toEqual(r.sel.elements.sort());
    expectWiresConsistent(doc, page);
    detachGroup(page, g.id);
    expect(groupSelection(page, g.id).elements).toEqual([]);
  });

  it("linked update keeps instance ids so external wires stay attached (and on their pins)", () => {
    const { content, inst } = placed("linked");
    const [ia, ib] = inst;
    const gid = ia.group!.id;
    const y = newElement(doc, page, TWO, { x: 1405, y: 505 });
    const ext = connect(y, "1", ia, "1");
    ia.info.label = "K5";
    // new revision: element A moved by 20, info changed; B unchanged
    const next: BlockContent = structuredClone(content);
    next.elements[0].x += 20;
    next.elements[0].info = { ...next.elements[0].info, function: "Main contactor", label: "IGNORED" };
    const res = updateBlockInstance(doc, page, gid, 2, next);
    expect(res).toEqual({ added: 0, removed: 0, updated: 2 });
    expect(page.elements.find((e) => e.id === ia.id)).toBeDefined();
    expect(ia.x).toBe(next.elements[0].x + 1000);
    expect(ia.info.label).toBe("K5"); // reference kept
    expect(ia.info.function).toBe("Main contactor"); // everything else from the block
    expect(ia.group!.revision).toBe(2);
    const w = page.wires.find((x) => x.id === ext.id)!;
    expect(w.b).toEqual({ k: "pin", el: ia.id, pin: "1" });
    expectWiresConsistent(doc, page);
    expect(computeNets(page).some((n) => n.pins.some((p) => p.el === y.id) && n.pins.some((p) => p.el === ia.id))).toBe(true);
    // internal wire was replaced and still connects the instance elements
    const internal = page.wires.filter((x) => x.group?.id === gid);
    expect(internal).toHaveLength(1);
    expect([internal[0].a, internal[0].b].map((e) => (e.k === "pin" ? e.el : e.k)).sort()).toEqual([ia.id, ib.id].sort());
  });

  it("derived update keeps the instance's own info", () => {
    const { content, inst } = placed("derived");
    const ia = inst[0];
    ia.info.function = "Local override";
    const next: BlockContent = structuredClone(content);
    next.elements[0].info = { ...next.elements[0].info, function: "From block" };
    updateBlockInstance(doc, page, ia.group!.id, 2, next);
    expect(ia.info.function).toBe("Local override");
    expect(ia.group!.revision).toBe(2);
  });

  it("removed pins make external wires dangling; removed elements are deleted, new ones added", () => {
    const { content, inst } = placed("linked");
    const [ia, ib] = inst;
    const y = newElement(doc, page, TWO, { x: 1405, y: 505 });
    const z = newElement(doc, page, TWO, { x: 1405, y: 905 });
    const toA = connect(y, "1", ia, "1");
    const toB = connect(z, "1", ib, "n");
    const next: BlockContent = structuredClone(content);
    // A's definition loses pin 1, element B disappears, a new element C appears
    next.defs[TWO.id] = { ...structuredClone(TWO), pins: TWO.pins.filter((p) => p.id !== "1") };
    const [ca] = next.elements;
    next.elements = [ca, { ...structuredClone(ca), id: "new-src", x: ca.x + 100 }];
    next.wires = [];
    const res = updateBlockInstance(doc, page, ia.group!.id, 3, next);
    expect(res).toEqual({ added: 1, removed: 1, updated: 1 });
    expect(page.elements.find((e) => e.id === ib.id)).toBeUndefined();
    expect(page.wires.find((w) => w.id === toA.id)!.b).toEqual({ k: "free" });
    expect(page.wires.find((w) => w.id === toB.id)!.b).toEqual({ k: "free" });
    expect(page.elements.filter((e) => e.group?.id === ia.group!.id)).toHaveLength(2);
  });

  it("returns zeros for an unknown group", () => {
    expect(updateBlockInstance(doc, page, "nope", 1, { defs: {}, elements: [], wires: [], junctions: [], texts: [], ports: [], bbox: { x: 0, y: 0, w: 0, h: 0 } })).toEqual({ added: 0, removed: 0, updated: 0 });
  });
});

describe("mergeToDef", () => {
  it("keeps pin count, relative positions and scene orientations", () => {
    const a = newElement(doc, page, TWO, { x: 105, y: 105 }, 1, false);
    const b = newElement(doc, page, FOUR, { x: 205, y: 165 }, 2, true);
    const c = newElement(doc, page, TWO, { x: 145, y: 245 }, 0, true);
    const els = [a, b, c];
    const def = mergeToDef(doc, page, els.map((e) => e.id), "Merged");
    const scenePins = els.flatMap((e) => doc.defs[e.defId].pins.map((p) => ({ p: toScene(e, p), o: rotOrient(p.orient, e.rot, e.mirror) })));
    expect(def.pins).toHaveLength(scenePins.length);
    // one common origin maps every merged pin onto its scene pin
    const off = { x: scenePins[0].p.x - def.pins[0].x, y: scenePins[0].p.y - def.pins[0].y };
    def.pins.forEach((p, i) => {
      expect({ x: p.x + off.x, y: p.y + off.y }).toEqual(scenePins[i].p);
      expect(p.orient).toBe(scenePins[i].o);
    });
    // the origin is a grid point, so placing the merged element there reproduces the pins exactly
    expect(((off.x - 5) % 10 + 10) % 10).toBe(0);
    expect(((off.y - 5) % 10 + 10) % 10).toBe(0);
    // every pin lies inside the declared definition box
    for (const p of def.pins) {
      expect(p.x).toBeGreaterThanOrEqual(-def.hotspotX);
      expect(p.x).toBeLessThanOrEqual(def.width - def.hotspotX);
      expect(p.y).toBeGreaterThanOrEqual(-def.hotspotY);
      expect(p.y).toBeLessThanOrEqual(def.height - def.hotspotY);
    }
    expect(new Set(def.pins.map((p) => p.id)).size).toBe(def.pins.length);
    expect(def.prims.length).toBe(3);
  });
});
