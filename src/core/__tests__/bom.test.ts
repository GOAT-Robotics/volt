import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { newDoc } from "../doc";
import type { Doc, ElemInst, ElementDef } from "../model";
import { buildBom, bomToCsv, bomToXlsx, compactRefs } from "../bom";

const def = (id: string, over: Partial<ElementDef> = {}): ElementDef => ({
  id, uuid: id, name: id, names: { en: id }, width: 20, height: 20, hotspotX: 0, hotspotY: 0, linkType: "simple", prefix: "", category: "",
  prims: [], pins: [{ id: "p1", x: 0, y: 0, orient: "n" } as never], info: {}, kind: {}, meta: {}, ...over,
});
let n = 0;
const el = (defId: string, info: Record<string, string>, extra: Partial<ElemInst> = {}): ElemInst => ({ id: `e${n++}`, defId, x: 0, y: 0, rot: 0, mirror: false, info, texts: [], ...extra });

function project(): Doc {
  const d = newDoc("Test");
  d.defs.relay = def("relay", { names: { en: "Relay coil" }, linkType: "master" });
  d.defs.contact = def("contact", { linkType: "slave" });
  d.defs.mcb = def("mcb", { names: { en: "MCB" } });
  d.defs.jn = def("jn", { name: "volt_junction" });
  d.defs.logo = def("logo", { pins: [] });
  const p1 = d.pages[0];
  const p2 = { ...p1, id: "p2", order: 1, elements: [] as ElemInst[] };
  d.pages.push(p2);
  p1.elements.push(
    el("relay", { label: "K1", description: "Relay 24 V", manufacturer: "Finder", manufacturer_reference: "40.52.9.024" }),
    el("relay", { label: "K2", description: "Relay 24 V", manufacturer: "Finder", manufacturer_reference: "40.52.9.024" }),
    el("contact", { label: "K1" }),
    el("mcb", { label: "Q1", description: "MCB", rating: "C10" }),
    el("mcb", { label: "Q2", description: "MCB", rating: "C10", bom: "no" }),
    el("jn", {}),
    el("logo", {}),
  );
  p2.elements.push(
    el("relay", { label: "K3", manufacturer: "Finder", manufacturer_reference: "40.52.9.024", quantity: "2" }),
    el("mcb", { label: "Q1" }), // same Q1 on another sheet: one component
  );
  return d;
}

describe("bill of materials", () => {
  it("groups by part number, merges references and skips non-parts", () => {
    const bom = buildBom(project());
    expect(bom.rows).toHaveLength(2);
    const relay = bom.rows.find((r) => r.partNumber === "40.52.9.024")!;
    expect(relay.qty).toBe(4); // K1 + K2 + K3 (quantity 2)
    expect(relay.refs).toEqual(["K1", "K2", "K3"]);
    expect(relay.sheets).toEqual([1, 2]);
    const mcb = bom.rows.find((r) => r.rating === "C10")!;
    expect(mcb.qty).toBe(1);
    expect(mcb.sheets).toEqual([1, 2]);
    expect(bom.excluded).toBe(1);
    expect(bom.missingPart).toBe(1);
  });

  it("one line per component and page filter", () => {
    const d = project();
    expect(buildBom(d, { grouping: "component" }).rows.map((r) => r.refs[0])).toEqual(["K1", "K2", "K3", "Q1"]);
    expect(buildBom(d, { pages: [d.pages[1]] }).components).toBe(2);
  });

  it("compacts reference runs", () => {
    expect(compactRefs(["K1", "K2", "K3", "K5", "Q1", "Q2"])).toBe("K1–K3, K5, Q1, Q2");
  });

  it("writes CSV and a valid xlsx package", () => {
    const bom = buildBom(project());
    const csv = bomToCsv(bom);
    expect(csv.startsWith("﻿Item,Qty")).toBe(true);
    expect(csv).toContain("K1–K3");
    const files = unzipSync(bomToXlsx(bom, { title: "Test" }));
    expect(Object.keys(files)).toContain("xl/worksheets/sheet1.xml");
    expect(strFromU8(files["xl/worksheets/sheet1.xml"])).toContain("40.52.9.024");
  });
});
