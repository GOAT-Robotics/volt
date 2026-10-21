import { describe, expect, it } from "vitest";
import type { Doc, ElemInst, Page } from "../model";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import { checkElectrical } from "../erc";
import { validateDoc } from "../validate";
import { replaceSymbol } from "../replace";
import { pageToSvg, approxMeasure } from "../render/svg";
import { freePins, setNoConnect } from "../noconnect";
import { mkDef, mkDoc } from "./helpers";

function wire(doc: Doc, page: Page, a: ElemInst, pa: string, b: ElemInst, pb: string) {
  const p1 = toScene(a, doc.defs[a.defId].pins.find((p) => p.id === pa)!), p2 = toScene(b, doc.defs[b.defId].pins.find((p) => p.id === pb)!);
  return addWire(page, { k: "pin", el: a.id, pin: pa, p: p1 }, { k: "pin", el: b.id, pin: pb, p: p2 }, [p1, { x: p1.x, y: p2.y }, p2])!;
}

/** a 4-pin IC: 1 and 2 wired to a lamp, 3 (required) and 4 open */
function board() {
  const { doc, page } = mkDoc();
  const ic = mkDef("ic", [
    { id: "1", x: -10, y: -10, orient: "w", number: "1" },
    { id: "2", x: -10, y: 10, orient: "w", number: "2" },
    { id: "3", x: 10, y: -10, orient: "e", number: "3", required: true },
    { id: "4", x: 10, y: 10, orient: "e", number: "4", name: "PE" },
  ], { name: "IC", prefix: "U" });
  const lamp = mkDef("lamp", [{ id: "a", x: 0, y: -20, orient: "n" }, { id: "b", x: 0, y: 20, orient: "s" }], { name: "Lamp", prefix: "H" });
  const u = newElement(doc, page, ic, { x: 205, y: 205 });
  u.info.label = "U1";
  const h = newElement(doc, page, lamp, { x: 105, y: 205 });
  h.info.label = "H1";
  wire(doc, page, u, "1", h, "a");
  wire(doc, page, u, "2", h, "b");
  return { doc, page, u, h };
}

const codes = (doc: Doc) => [...checkElectrical(doc).map((f) => f.code), ...validateDoc(doc).map((i) => i.code)];

describe("no connect", () => {
  it("open pins marked no connect are not reported; a wired one is", () => {
    const { doc, page, u } = board();
    expect(codes(doc)).toContain("pin.unconnected");
    expect(codes(doc)).toContain("erc.peOpen");
    expect(freePins(doc, u)).toEqual(["3", "4"]);
    setNoConnect(u, ["3", "4"], true);
    expect(codes(doc)).not.toContain("pin.unconnected");
    expect(codes(doc)).not.toContain("erc.peOpen");
    expect(codes(doc)).not.toContain("erc.noConnectWired");
    // a wire lands on a flagged pin after all
    setNoConnect(u, ["1"], true);
    const f = checkElectrical(doc).find((x) => x.code === "erc.noConnectWired");
    expect(f?.message).toMatch(/U1: pin 1 is marked "no connect" but connected/);
    void page;
  });

  it("a component whose pins are all no connect is not 'unwired'", () => {
    const { doc, page } = mkDoc();
    const spare = newElement(doc, page, mkDef("spare", [{ id: "1", x: 0, y: -20, orient: "n" }, { id: "2", x: 0, y: 20, orient: "s" }], { prefix: "K" }), { x: 405, y: 205 });
    spare.info.label = "K9";
    expect(codes(doc)).toContain("erc.unwired");
    setNoConnect(spare, ["1", "2"], true);
    expect(codes(doc)).not.toContain("erc.unwired");
  });

  it("draws an ✕ on an open flagged pin, none once it is wired", () => {
    const { doc, page, u } = board();
    const crosses = (svg: string) => (svg.match(/M(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)L(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)M/g) ?? []).length;
    const before = crosses(pageToSvg(doc, page, { measure: approxMeasure, decor: false }));
    setNoConnect(u, ["3"], true);
    const svg = pageToSvg(doc, page, { measure: approxMeasure, decor: false });
    // pin 3 of U1 is at (215, 195): the ✕ runs corner to corner around it
    expect(svg).toMatch(/M212 192L218 198M212 198L218 192/);
    expect(crosses(svg)).toBe(before + 1);
    setNoConnect(u, ["1"], true); // wired: no ✕
    expect(pageToSvg(doc, page, { measure: approxMeasure, decor: false })).not.toMatch(/M192 192L198 198/);
  });

  it("keeps the flags on the matching pins when the symbol is replaced", () => {
    const { doc, page, u } = board();
    setNoConnect(u, ["3", "4"], true);
    const ic2 = mkDef("ic2", [
      { id: "p1", x: -10, y: -10, orient: "w", number: "1" },
      { id: "p2", x: -10, y: 10, orient: "w", number: "2" },
      { id: "p3", x: 10, y: -10, orient: "e", number: "3" },
      { id: "p4", x: 10, y: 10, orient: "e", number: "4" },
    ], { name: "IC v2", prefix: "U" });
    replaceSymbol(doc, page, u, ic2);
    expect(u.noConnect?.sort()).toEqual(["p3", "p4"]);
  });
});
