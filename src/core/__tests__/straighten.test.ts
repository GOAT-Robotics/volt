import { describe, expect, it } from "vitest";
import { produce } from "immer";
import type { Doc, ElementDef, ElemInst, Page, PinDef, Wire } from "../model";
import { newDoc } from "../doc";
import { toScene } from "../geometry";
import { gridFriendlyScales, offGridComponents, straightenWires } from "../straighten";

const pin = (id: string, x: number, y: number, orient: PinDef["orient"]): PinDef => ({ id, x, y, orient, name: "", number: id, type: "Generic" });
const def = (id: string, pins: PinDef[], w = 20, h = 20): ElementDef => ({
  id, uuid: id, name: id, names: { en: id }, width: w, height: h, hotspotX: w / 2, hotspotY: h / 2, linkType: "simple", prefix: "X", category: "test",
  prims: [{ t: "rect", x: -w / 2, y: -h / 2, w, h, rx: 0, ry: 0, style: { lineStyle: "normal", lineWeight: "normal", filling: "none", color: "black" } }],
  pins, info: {}, kind: {}, meta: {},
});
const ARROW = def("arrow", [pin("1", 10, 0, "e")], 20, 10);
/** a compact 3-pole connector half: pins 10 apart at the top, turned so they face left (plug) or right (socket) */
const PLUG = { ...def("plug", [pin("1", 10, -10, "n"), pin("2", 0, -10, "n"), pin("3", -10, -10, "n")]), name: "Plug 3-pole (male)" };
const SOCKET = { ...def("socket", [pin("1", -10, -10, "n"), pin("2", 0, -10, "n"), pin("3", 10, -10, "n")]), name: "Socket 3-pole (female)" };

let n = 0;
const el = (defId: string, x: number, y: number, extra: Partial<ElemInst> = {}): ElemInst => ({ id: `e${++n}`, defId, x, y, rot: 0, mirror: false, info: {}, texts: [], ...extra });
const pinEnd = (e: ElemInst, p: string) => ({ k: "pin" as const, el: e.id, pin: p });
function wire(doc: Doc, page: Page, a: Wire["a"], b: Wire["b"]): Wire {
  const pt = (end: Wire["a"]) => {
    if (end.k === "pin") {
      const e = page.elements.find((x) => x.id === end.el)!;
      return toScene(e, doc.defs[e.defId].pins.find((p) => p.id === end.pin)!);
    }
    if (end.k === "junction") {
      const j = page.junctions.find((x) => x.id === end.j)!;
      return { x: j.x, y: j.y };
    }
    return { x: 0, y: 0 };
  };
  const A = pt(a), B = pt(b);
  // a bent route: across at the middle (what misaligned pins get)
  const mx = Math.round((A.x + B.x) / 20) * 10 + 5;
  const w: Wire = { id: `w${++n}`, a, b, pts: [A, { x: mx, y: A.y }, { x: mx, y: B.y }, B] };
  page.wires.push(w);
  return w;
}

/** arrows → plug/socket (146 %) → a device drawn as a box with three junction "pins" 20 apart (like GT-OMNI's RGB sheet) */
function rgbSheet() {
  const doc = newDoc("t");
  doc.defs = { arrow: ARROW, plug: PLUG, socket: SOCKET };
  const page = doc.pages[0];
  const plug = el("plug", 375, 225, { rot: 3, scale: 1.46, info: { label: "XC7" } });
  const socket = el("socket", 375, 225, { rot: 1, scale: 1.46, info: { label: "XC7-F" } });
  plug.mate = { id: socket.id, gender: "male" };
  socket.mate = { id: plug.id, gender: "female" };
  const arrows = [175, 215, 245].map((y) => el("arrow", 235, y, { info: { label: "RGB CONTROLLER" } }));
  page.elements.push(plug, socket, ...arrows);
  page.junctions.push(...[215, 235, 255].map((y, i) => ({ id: `j${i}`, x: 1015, y })));
  for (let i = 0; i < 3; i++) {
    wire(doc, page, pinEnd(arrows[i], "1"), pinEnd(plug, String(i + 1)));
    wire(doc, page, { k: "junction", j: `j${i}` }, pinEnd(socket, String(i + 1)));
    // keep the junction "pins" alive (a second wire on each)
    page.wires.push({ id: `stub${i}`, a: { k: "junction", j: `j${i}` }, b: { k: "free" }, pts: [{ x: 1015, y: [215, 235, 255][i] }, { x: 1035, y: [215, 235, 255][i] }] });
  }
  return { doc, page, plug, socket, arrows };
}
const bends = (p: Page) => p.wires.reduce((s, w) => s + Math.max(0, w.pts.length - 2), 0);

describe("straighten wires", () => {
  it("finds components whose size puts their pins off the grid and the sizes that fix it", () => {
    const { doc, page, plug } = rgbSheet();
    expect(offGridComponents(doc, page).map((x) => x.id)).toEqual([plug.id, page.elements[1].id]);
    expect(gridFriendlyScales(doc, plug)).toEqual([100, 200, 300]);
  });

  it("lines up a connector chain: size onto the grid, connector to the device, arrows to the connector", () => {
    const s = rgbSheet();
    expect(bends(s.page)).toBe(12);
    let r!: ReturnType<typeof straightenWires>;
    const doc = produce(s.doc, (d) => void (r = straightenWires(d, d.pages[0], { move: [s.plug.id, ...s.arrows.map((a) => a.id)] })));
    const page = doc.pages[0];
    expect(r.resized).toEqual([{ id: s.plug.id, from: 146, to: 200 }]);
    expect(r.moved[0]).toMatchObject({ id: s.plug.id, dx: 0, dy: 10, lined: 3 });
    expect(page.elements.find((e) => e.id === s.socket.id)).toMatchObject({ x: 375, y: 235, scale: 2 }); // moved with its mate
    expect(page.elements.filter((e) => e.defId === "arrow").map((e) => e.y)).toEqual([215, 235, 255]);
    expect(bends(page)).toBe(0);
    expect(r.straight.length).toBe(6);
    expect(r.offGrid).toEqual([]);
  });

  it("without components it only redraws wires that can already be straight", () => {
    const s = rgbSheet();
    const doc = produce(s.doc, (d) => {
      // the bottom arrow is already in line with pin 3 at 146 %? no — put one arrow exactly in line
      const a = d.pages[0].elements.find((e) => e.id === s.arrows[1].id)!;
      a.y = 225;
      const w = d.pages[0].wires.find((x) => x.a.k === "pin" && x.a.el === a.id)!;
      w.pts = [{ x: 245, y: 225 }, { x: 300, y: 225 }, { x: 300, y: 205 }, { x: 300, y: 225 }, toScene(d.pages[0].elements[0], PLUG.pins[1])];
    });
    let r!: ReturnType<typeof straightenWires>;
    const next = produce(doc, (d) => void (r = straightenWires(d, d.pages[0])));
    expect(r.moved).toEqual([]);
    expect(r.straight.length).toBe(1);
    const w = next.pages[0].wires.find((x) => x.a.k === "pin" && x.a.el === s.arrows[1].id)!;
    expect(w.pts.length).toBe(2);
  });

  it("never moves a component onto another one", () => {
    const s = rgbSheet();
    const doc = produce(s.doc, (d) => {
      // a lamp sits where the top arrow would go
      d.defs.lamp = def("lamp", [], 20, 20);
      d.pages[0].elements.push(el("lamp", 235, 205, { info: { label: "H1" } }));
    });
    let r!: ReturnType<typeof straightenWires>;
    produce(doc, (d) => void (r = straightenWires(d, d.pages[0], { move: [s.plug.id, ...s.arrows.map((a) => a.id)] })));
    expect(r.moved.some((m) => m.id === s.arrows[0].id)).toBe(false);
    expect(r.stayed.find((x) => x.id === s.arrows[0].id)?.why).toMatch(/overlap H1/);
  });

  it("does not move a connector that would line up only one of its wires (sizes off)", () => {
    const s = rgbSheet();
    let r!: ReturnType<typeof straightenWires>;
    produce(s.doc, (d) => void (r = straightenWires(d, d.pages[0], { move: [s.plug.id], fixSizes: false })));
    expect(r.resized).toEqual([]);
    expect(r.moved).toEqual([]);
    expect(r.stayed[0].why).toMatch(/only 1 of 6 wires/); // the plug and its socket on top of it move as one
    expect(r.offGrid.length).toBe(2);
  });

  it("lines up a connector between arrows when nothing else stays put", () => {
    const doc = newDoc("t");
    doc.defs = { arrow: ARROW, plug: PLUG };
    const page = doc.pages[0];
    const plug = el("plug", 375, 225, { rot: 3 });
    const a1 = el("arrow", 235, 205), a2 = el("arrow", 235, 235); // pins 30 apart, the plug's 10 apart
    page.elements.push(plug, a1, a2);
    wire(doc, page, pinEnd(a1, "1"), pinEnd(plug, "1"));
    wire(doc, page, pinEnd(a2, "1"), pinEnd(plug, "2"));
    let r!: ReturnType<typeof straightenWires>;
    const next = produce(doc, (d) => void (r = straightenWires(d, d.pages[0], { move: [plug.id, a1.id, a2.id] })));
    expect(bends(next.pages[0])).toBe(0);
    expect(r.moved.length).toBeGreaterThan(0);
  });

  it("never draws a straight wire through another symbol", () => {
    const s = rgbSheet();
    let r!: ReturnType<typeof straightenWires>;
    const next = produce(s.doc, (d) => {
      // the arrows already in line with the plug at 200 %, a lamp in the way of the middle wire
      d.defs.lamp = def("lamp", [], 20, 20);
      d.pages[0].elements.push(el("lamp", 300, 235, { info: { label: "H2" } }));
      r = straightenWires(d, d.pages[0], { move: [s.plug.id, ...s.arrows.map((a) => a.id)] });
    });
    const mid = next.pages[0].wires.find((w) => w.a.k === "pin" && w.a.el === s.arrows[1].id)!;
    expect(mid.pts.length).toBeGreaterThan(2); // the arrow is not lined up through the lamp
    expect(r.moved.some((m) => m.id === s.arrows[1].id)).toBe(false);
    expect(r.moved.some((m) => m.id === s.arrows[2].id)).toBe(true);
    // the top arrow would land on the middle one (its wire along the middle one's), which stayed: it stays too
    expect(r.moved.some((m) => m.id === s.arrows[0].id)).toBe(false);
    expect(r.stayed.find((x) => x.id === s.arrows[0].id)?.why).toMatch(/overlap|no move lines/);
    // in line already, with the lamp in the way: left as it is and reported
    const inLine = produce(next, (d) => {
      const pg = d.pages[0];
      const a = pg.elements.find((e) => e.id === s.arrows[1].id)!;
      a.y = 235;
      const w = pg.wires.find((x) => x.id === mid.id)!;
      w.pts = [{ x: 245, y: 235 }, { x: 260, y: 235 }, { x: 260, y: 270 }, { x: 330, y: 270 }, { x: 330, y: 235 }, { x: 355, y: 235 }];
      r = straightenWires(d, pg, { wires: [w.id] });
    });
    expect(r.blocked).toEqual([mid.id]);
    expect(inLine.pages[0].wires.find((x) => x.id === mid.id)!.pts.length).toBe(6);
  });

  it("moves nothing further than maxShift", () => {
    const s = rgbSheet();
    let r!: ReturnType<typeof straightenWires>;
    produce(s.doc, (d) => void (r = straightenWires(d, d.pages[0], { move: s.arrows.map((a) => a.id), maxShift: 2 })));
    expect(r.moved).toEqual([]);
  });

  it("re-routes what cannot be straight with the fewest bends when asked", () => {
    const s = rgbSheet();
    const doc = produce(s.doc, (d) => {
      const w = d.pages[0].wires[0];
      const a = w.pts[0], b = w.pts[w.pts.length - 1];
      w.pts = [a, { x: a.x + 20, y: a.y }, { x: a.x + 20, y: a.y + 60 }, { x: a.x + 40, y: a.y + 60 }, { x: a.x + 40, y: b.y }, b];
    });
    let r!: ReturnType<typeof straightenWires>;
    const next = produce(doc, (d) => void (r = straightenWires(d, d.pages[0], { wires: [d.pages[0].wires[0].id], reroute: true })));
    expect(r.rerouted.length).toBe(1);
    expect(next.pages[0].wires[0].pts.length).toBeLessThanOrEqual(4);
    // never more bends than before
    const again = produce(next, (d) => void (r = straightenWires(d, d.pages[0], { wires: [d.pages[0].wires[0].id], reroute: true })));
    expect(r.rerouted).toEqual([]);
    expect(again.pages[0].wires[0].pts.length).toBe(next.pages[0].wires[0].pts.length);
  });
});

describe("straighten wires: pins that face away", () => {
  it("does not line an arrow up with a pin that points across the wire", () => {
    const doc = newDoc("t");
    // a box with a pin on its bottom edge pointing down, an arrow below-left of it
    const BOX = def("box", [pin("23", 0, 20, "s")], 60, 40);
    doc.defs = { arrow: ARROW, box: BOX };
    const page = doc.pages[0];
    const box = el("box", 505, 205);
    const arrow = el("arrow", 305, 285);
    page.elements.push(box, arrow);
    wire(doc, page, pinEnd(arrow, "1"), pinEnd(box, "23"));
    let r!: ReturnType<typeof straightenWires>;
    produce(doc, (d) => void (r = straightenWires(d, d.pages[0], { move: [arrow.id] })));
    expect(r.moved).toEqual([]);
  });
});

describe("straighten wires: junction pins on drawn boxes", () => {
  it("keeps a wire coming into a junction from below", () => {
    const doc = newDoc("t");
    doc.defs = { arrow: ARROW };
    const page = doc.pages[0];
    const arrow = el("arrow", 305, 315);
    page.elements.push(arrow);
    page.junctions.push({ id: "j", x: 505, y: 255 });
    const w: Wire = { id: "w", a: pinEnd(arrow, "1"), b: { k: "junction", j: "j" }, pts: [{ x: 315, y: 315 }, { x: 505, y: 315 }, { x: 505, y: 255 }] };
    // a real T: the box edge runs on both sides of the junction
    page.wires.push(w, { id: "stub", a: { k: "junction", j: "j" }, b: { k: "free" }, pts: [{ x: 505, y: 255 }, { x: 525, y: 255 }] }, { id: "stub2", a: { k: "junction", j: "j" }, b: { k: "free" }, pts: [{ x: 505, y: 255 }, { x: 485, y: 255 }] });
    let r!: ReturnType<typeof straightenWires>;
    const next = produce(doc, (d) => void (r = straightenWires(d, d.pages[0], { move: [arrow.id] })));
    expect(r.moved).toEqual([]);
    expect(next.pages[0].wires.find((x) => x.id === "w")!.pts.length).toBe(3);
  });
});

describe("straighten wires: chains through parts that cannot follow", () => {
  it("does not bend a straight wire to a part that would have to bend another wire to follow", () => {
    // a splice wired straight up to a contact (itself wired straight up again) and bent down to a breaker pin 20 to the right
    const doc = newDoc("t");
    const SPLICE = def("splice", [pin("1", 0, 0, "n"), pin("2", 0, 0, "s")], 4, 4);
    const CONTACT = def("contact", [pin("1", 0, -10, "n"), pin("2", 0, 10, "s")], 10, 20);
    doc.defs = { splice: SPLICE, contact: CONTACT, arrow: ARROW };
    const page = doc.pages[0];
    const top = el("contact", 125, 105);
    const contact = el("contact", 125, 205);
    const splice = el("splice", 125, 305);
    const breaker = el("contact", 145, 405);
    page.elements.push(top, contact, splice, breaker);
    const at = (e: ElemInst, p: string) => toScene(e, doc.defs[e.defId].pins.find((x) => x.id === p)!);
    page.wires.push(
      { id: "up2", a: pinEnd(top, "2"), b: pinEnd(contact, "1"), pts: [at(top, "2"), at(contact, "1")] },
      { id: "up", a: pinEnd(contact, "2"), b: pinEnd(splice, "1"), pts: [at(contact, "2"), at(splice, "1")] },
      { id: "down", a: pinEnd(splice, "2"), b: pinEnd(breaker, "1"), pts: [at(splice, "2"), { x: 125, y: 355 }, { x: 145, y: 355 }, at(breaker, "1")] },
    );
    let r!: ReturnType<typeof straightenWires>;
    const next = produce(doc, (d) => void (r = straightenWires(d, d.pages[0], { move: [contact.id, splice.id] })));
    expect(r.moved).toEqual([]);
    expect(next.pages[0].wires.find((w) => w.id === "up")!.pts.length).toBe(2);
  });
});
