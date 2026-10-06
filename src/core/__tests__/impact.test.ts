import { describe, expect, it } from "vitest";
import { addWire, emptySel, newElement } from "../ops";
import { toScene } from "../geometry";
import type { Doc, ElemInst, Page, Wire } from "../model";
import { mkDef, mkDoc, twoPin } from "./helpers";
import { applyRefChanges, deleteImpact, deleteWithRelated, needsConfirmation, planCloseGaps } from "../impact";
import { newPage } from "../doc";

function wire(doc: Doc, page: Page, a: ElemInst, pa: string, b: ElemInst, pb: string, extra: Partial<Wire> = {}) {
  const da = doc.defs[a.defId], db = doc.defs[b.defId];
  const p1 = toScene(a, da.pins.find((p) => p.id === pa)!), p2 = toScene(b, db.pins.find((p) => p.id === pb)!);
  return addWire(page, { k: "pin", el: a.id, pin: pa, p: p1 }, { k: "pin", el: b.id, pin: pb, p: p2 }, [p1, { x: p1.x, y: p2.y }, p2], extra)!;
}
const codes = (i: ReturnType<typeof deleteImpact>) => i.items.map((x) => x.code);

describe("deleteImpact", () => {
  it("a lone component with nothing else using it needs no confirmation", () => {
    const { doc, page } = mkDoc();
    const k = newElement(doc, page, twoPin("relay"), { x: 105, y: 105 });
    k.info.label = "K1";
    const i = deleteImpact(doc, page, { ...emptySel(), elements: [k.id] });
    expect(needsConfirmation(i)).toBe(false);
    expect(i.freedRefs).toEqual(["K1"]);
  });

  it("coil with contacts on another sheet, attached wires and broken connections", () => {
    const { doc, page } = mkDoc();
    const coil = newElement(doc, page, twoPin("coil", { linkType: "master", name: "coil" }), { x: 105, y: 105 });
    const f = newElement(doc, page, twoPin("fuse", { prefix: "F" }), { x: 305, y: 105 });
    const h = newElement(doc, page, twoPin("lamp", { prefix: "P" }), { x: 505, y: 105 });
    coil.info.label = "K1";
    const p2 = newPage(1, "Sheet 2");
    doc.pages.push(p2);
    const contact = newElement(doc, p2, twoPin("contact", { linkType: "slave" }), { x: 105, y: 105 });
    contact.info.label = "K1";
    coil.links = [contact.id];
    contact.links = [coil.id];
    wire(doc, page, f, "2", coil, "1");
    wire(doc, page, coil, "1", h, "1"); // K1:1 is a pass-through point between F and P
    const i = deleteImpact(doc, page, { ...emptySel(), elements: [coil.id] });
    expect(codes(i)).toEqual(expect.arrayContaining(["wires.dangling", "xref.slaves", "net.split"]));
    expect(needsConfirmation(i)).toBe(true);
    expect(i.freedRefs).toEqual([]); // the contact still carries K1
    // delete with the contacts too
    const rel = i.items.find((x) => x.code === "xref.slaves")!.related!;
    deleteWithRelated(doc, page.id, { ...emptySel(), elements: [coil.id] }, rel);
    expect(p2.elements.find((e) => e.id === contact.id)).toBeUndefined();
  });

  it("wire whose circuit continues on another sheet", () => {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, twoPin("r"), { x: 105, y: 105 });
    const b = newElement(doc, page, twoPin("r"), { x: 305, y: 305 });
    const w = wire(doc, page, a, "2", b, "1", { label: "101" });
    const p2 = newPage(1, "Sheet 2");
    doc.pages.push(p2);
    const c = newElement(doc, p2, twoPin("r"), { x: 105, y: 105 });
    const d = newElement(doc, p2, twoPin("r"), { x: 305, y: 305 });
    wire(doc, p2, c, "2", d, "1", { label: "101" });
    const i = deleteImpact(doc, page, { ...emptySel(), wires: [w.id] });
    expect(codes(i)).toContain("wire.continues");
    expect(codes(i)).toContain("net.split");
  });

  it("part of a placed block", () => {
    const { doc, page } = mkDoc();
    const g = { id: "g1", blockId: "b", revision: 1, mode: "linked" as const, name: "DOL starter" };
    const a = newElement(doc, page, twoPin("r"), { x: 105, y: 105 });
    const b = newElement(doc, page, twoPin("r"), { x: 305, y: 105 });
    a.group = g;
    b.group = g;
    const i = deleteImpact(doc, page, { ...emptySel(), elements: [a.id] });
    const it = i.items.find((x) => x.code === "block.partial")!;
    expect(it.message).toMatch(/DOL starter/);
    expect(it.related?.[0].elements).toEqual([b.id]);
  });

  it("mated connector and folio report counterparts", () => {
    const { doc, page } = mkDoc();
    const rep = mkDef("rep", [{ id: "1", x: 0, y: 0, orient: "e" }], { linkType: "next_report", prefix: "" });
    const r1 = newElement(doc, page, rep, { x: 105, y: 105 });
    const p2 = newPage(1, "Sheet 2");
    doc.pages.push(p2);
    const r2 = newElement(doc, p2, rep, { x: 105, y: 105 });
    r1.links = [r2.id];
    r2.links = [r1.id];
    expect(codes(deleteImpact(doc, page, { ...emptySel(), elements: [r1.id] }))).toContain("xref.report");
  });
});

describe("planCloseGaps", () => {
  it("closes gaps per prefix, renames every element of a device, skips locked and terminals", () => {
    const { doc, page } = mkDoc();
    const def = twoPin("relay");
    const mk = (l: string, locked = false) => {
      const e = newElement(doc, page, def, { x: 105, y: 105 });
      e.info.label = l;
      e.refLocked = locked;
      return e;
    };
    mk("K1");
    const k4 = mk("K4");
    const k4b = mk("K4"); // second representation of K4
    mk("K3", true); // locked: keeps 3
    const k9 = mk("K9");
    const f02 = mk("F02");
    const ch = planCloseGaps(doc);
    applyRefChanges(doc, ch);
    expect(k4.info.label).toBe("K2");
    expect(k4b.info.label).toBe("K2");
    expect(k9.info.label).toBe("K4");
    expect(f02.info.label).toBe("F01"); // padding kept
  });
});
