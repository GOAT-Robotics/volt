import { describe, expect, it } from "vitest";
import { validateDoc, type Issue } from "../validate";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import { newPage } from "../doc";
import { mkDef, mkDoc, twoPin } from "./helpers";

const codes = (is: Issue[]) => is.map((i) => i.code);
function setup() {
  const { doc, page } = mkDoc();
  const def = twoPin("relay");
  const a = newElement(doc, page, def, { x: 105, y: 105 });
  const b = newElement(doc, page, def, { x: 405, y: 305 });
  a.info.label = "K1";
  b.info.label = "K2";
  const pa = toScene(a, def.pins[1]), pb = toScene(b, def.pins[0]);
  addWire(page, { k: "pin", el: a.id, pin: "2", p: pa }, { k: "pin", el: b.id, pin: "1", p: pb }, [pa, { x: pa.x, y: pb.y }, pb]);
  return { doc, page, def, a, b };
}

describe("validateDoc", () => {
  it("a clean document has no errors or warnings", () => {
    const { doc } = setup();
    expect(validateDoc(doc).filter((i) => i.level !== "info")).toEqual([]);
  });

  it("dangling wire ends", () => {
    const { doc, page } = setup();
    page.wires[0].b = { k: "free" };
    const is = validateDoc(doc).filter((i) => i.code === "wire.dangling");
    expect(is).toHaveLength(1);
    expect(is[0]).toMatchObject({ level: "warning", pageId: page.id, ids: [page.wires[0].id] });
  });

  it("duplicate references (error) across pages", () => {
    const { doc, def, a } = setup();
    const p2 = newPage(1);
    doc.pages.push(p2);
    const c = newElement(doc, p2, def, { x: 105, y: 105 });
    c.info.label = "K1";
    const is = validateDoc(doc).filter((i) => i.code === "ref.duplicate");
    expect(is).toHaveLength(1);
    expect(is[0].level).toBe("error");
    expect(is[0].ids.sort()).toEqual([a.id, c.id].sort());
    // errors sort first
    expect(validateDoc(doc)[0].level).toBe("error");
  });

  it("missing references for elements that need one", () => {
    const { doc, page, a } = setup();
    a.info.label = "";
    newElement(doc, page, mkDef("deco", [], { prefix: "X" }), { x: 605, y: 105 }); // pinless: no ref needed
    const is = validateDoc(doc).filter((i) => i.code === "ref.missing");
    expect(is.map((i) => i.ids)).toEqual([[a.id]]);
  });

  it("broken wire references (missing pin / element / junction)", () => {
    const { doc, page, a } = setup();
    page.wires[0].a = { k: "pin", el: a.id, pin: "nope" };
    page.wires[0].b = { k: "junction", j: "ghost" };
    page.wires.push({ id: "w2", a: { k: "pin", el: "ghost", pin: "1" }, b: { k: "free" }, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const is = validateDoc(doc).filter((i) => i.code === "wire.broken");
    expect(is).toHaveLength(3);
    expect(is.every((i) => i.level === "error")).toBe(true);
  });

  it("required pins must be connected", () => {
    const { doc, page } = setup();
    const req = mkDef("psu", [
      { id: "+", x: 0, y: -20, orient: "n", number: "+", required: true },
      { id: "-", x: 0, y: 20, orient: "s", number: "-", required: true },
      { id: "pe", x: 10, y: 0, orient: "e", number: "PE" },
    ], { prefix: "G" });
    const g = newElement(doc, page, req, { x: 705, y: 305 });
    g.info.label = "G1";
    let is = validateDoc(doc).filter((i) => i.code === "pin.unconnected");
    expect(is.map((i) => i.message).sort()).toEqual([`${page.title}: G1 pin + must be connected`, `${page.title}: G1 pin - must be connected`]);
    const p = toScene(g, req.pins[0]);
    addWire(page, { k: "pin", el: g.id, pin: "+", p }, { k: "free", p: { x: p.x, y: p.y - 40 } }, [p, { x: p.x, y: p.y - 40 }]);
    is = validateDoc(doc).filter((i) => i.code === "pin.unconnected");
    expect(is).toHaveLength(1);
  });

  it("overlapping labels of different elements", () => {
    const { doc, page, def } = setup();
    expect(codes(validateDoc(doc))).not.toContain("label.overlap");
    const c = newElement(doc, page, def, { x: 105, y: 107 });
    c.info.label = "K3";
    const is = validateDoc(doc).filter((i) => i.code === "label.overlap");
    expect(is.length).toBeGreaterThanOrEqual(1);
    expect(is[0].ids).toContain(c.id);
  });

  it("library status: outdated, broken, deprecated", () => {
    const { doc } = setup();
    const lib = mkDef("lib:abc@2", [{ id: "1", x: 0, y: 0, orient: "n" }], { name: "Lamp", source: { libraryElementId: "abc", revision: 2 } });
    doc.defs[lib.id] = lib;
    expect(validateDoc(doc).filter((i) => i.code.startsWith("lib."))).toEqual([]); // no library context → nothing
    let is = validateDoc(doc, { library: { abc: { revision: 3, status: "APPROVED" } } });
    expect(is.filter((i) => i.code === "lib.outdated")).toMatchObject([{ level: "info" }]);
    is = validateDoc(doc, { library: { abc: null } });
    expect(codes(is)).toContain("lib.broken");
    is = validateDoc(doc, { library: { abc: { revision: 2, status: "DEPRECATED" } } });
    expect(codes(is)).toContain("lib.deprecated");
    is = validateDoc(doc, { library: { abc: { revision: 2, status: "APPROVED" } } });
    expect(codes(is).filter((c) => c.startsWith("lib."))).toEqual([]);
  });

  it("other checks: element without def, zero-length wire, duplicate pin numbers, placeholder defs, duplicate page titles", () => {
    const { doc, page } = setup();
    page.elements.push({ id: "orphan", defId: "missing", x: 0, y: 0, rot: 0, mirror: false, info: {}, texts: [] });
    page.wires.push({ id: "z", a: { k: "free" }, b: { k: "free" }, pts: [{ x: 5, y: 5 }, { x: 5, y: 5 }] });
    doc.defs.dup = mkDef("dup", [{ id: "a", x: 0, y: 0, orient: "n", number: "1" }, { id: "b", x: 0, y: 10, orient: "s", number: "1" }]);
    doc.defs.ph = { ...mkDef("ph", []), placeholder: true };
    doc.pages.push({ ...newPage(1), title: page.title });
    const c = codes(validateDoc(doc));
    expect(c).toEqual(expect.arrayContaining(["elem.nodef", "wire.zero", "def.pinDuplicate", "def.missing", "page.duplicate"]));
  });
});
