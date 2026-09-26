import { describe, expect, it } from "vitest";
import type { Doc, ElemInst, NumberingRule, Page } from "../model";
import { newDoc, newPage } from "../doc";
import { duplicateRefs, nextRef, parseRef, planRenumber, prefixFor, ruleFor } from "../numbering";
import { newElement } from "../ops";
import { mkDef, twoPin } from "./helpers";

const RELAY = twoPin("relay", { prefix: "K", category: "control/relays" });
const MOTOR = twoPin("motor", { prefix: "M", category: "power/motors" });
const SLAVE = twoPin("contact", { prefix: "K", linkType: "slave" });
const REPORT = twoPin("report", { prefix: "R", linkType: "next_report" });
const DECO = mkDef("deco", [], { prefix: "X" });

function setup(rules: Partial<NumberingRule>[], pages = 2): { doc: Doc; pages: Page[] } {
  const doc = newDoc("N");
  doc.pages = Array.from({ length: pages }, (_, i) => newPage(i));
  doc.numbering.rules = rules.map((r, i) => ({ id: `r${i}`, match: "*", prefix: "", scope: "project", format: "{prefix}{n}", start: 1, ...r }));
  doc.numbering.autoOnPlace = true;
  return { doc, pages: doc.pages };
}
const put = (doc: Doc, page: Page, def = RELAY, x = 105, y = 105, info: Record<string, string> = {}): ElemInst => {
  const e = newElement(doc, page, def, { x, y });
  if (Object.keys(info).length) {
    // re-number with the location info set (as the editor does after editing properties)
    Object.assign(e.info, info);
    e.info.label = "";
    e.info.label = nextRef(doc, page, e);
  }
  return e;
};

describe("ruleFor / prefixFor", () => {
  it("prefers a rule matching the def prefix or category over '*'", () => {
    const { doc } = setup([{ match: "*" }, { match: "M", prefix: "MOT" }, { match: "control", prefix: "KA" }]);
    expect(ruleFor(doc, MOTOR)!.id).toBe("r1");
    expect(prefixFor(doc, MOTOR)).toBe("MOT");
    expect(prefixFor(doc, RELAY)).toBe("KA");
    expect(ruleFor(doc, twoPin("x", { prefix: "Q" }))!.id).toBe("r0");
    expect(prefixFor(doc, twoPin("x", { prefix: "Q" }))).toBe("Q");
  });
});

describe("nextRef", () => {
  it("project scope: one counter across all pages, first free number", () => {
    const { doc, pages } = setup([{ scope: "project" }]);
    expect(put(doc, pages[0]).info.label).toBe("K1");
    expect(put(doc, pages[1]).info.label).toBe("K2");
    expect(put(doc, pages[0], MOTOR).info.label).toBe("M1");
    const k3 = put(doc, pages[1]);
    expect(k3.info.label).toBe("K3");
    pages[0].elements = pages[0].elements.filter((e) => e.info.label !== "K1");
    expect(put(doc, pages[1]).info.label).toBe("K1");
  });

  it("page scope with {page}{prefix}{n:2}", () => {
    const { doc, pages } = setup([{ scope: "page", format: "{page}{prefix}{n:2}" }]);
    expect(put(doc, pages[0]).info.label).toBe("1K01");
    expect(put(doc, pages[0]).info.label).toBe("1K02");
    expect(put(doc, pages[1]).info.label).toBe("2K01");
    expect(put(doc, pages[1], MOTOR).info.label).toBe("2M01");
  });

  it("page number follows page order, not array order", () => {
    const { doc, pages } = setup([{ scope: "page", format: "{page}{prefix}{n}" }]);
    pages[0].order = 5;
    expect(put(doc, pages[0]).info.label).toBe("2K1");
    expect(put(doc, pages[1]).info.label).toBe("1K1");
  });

  it("location scope with {location}", () => {
    const { doc, pages } = setup([{ scope: "location", format: "{location}-{prefix}{n}" }]);
    expect(put(doc, pages[0], RELAY, 105, 105, { location: "+A1" }).info.label).toBe("+A1-K1");
    expect(put(doc, pages[1], RELAY, 105, 105, { location: "+A1" }).info.label).toBe("+A1-K2");
    expect(put(doc, pages[0], RELAY, 205, 105, { location: "+B2" }).info.label).toBe("+B2-K1");
  });

  it("respects the start number and zero padding", () => {
    const { doc, pages } = setup([{ format: "{prefix}{n:3}", start: 10 }]);
    expect(put(doc, pages[0]).info.label).toBe("K010");
  });

  it("never produces a reference that is already used elsewhere in the project", () => {
    for (const scope of ["project", "page", "location"] as const) {
      const { doc, pages } = setup([{ scope, format: "{prefix}{n}" }], 3);
      for (let i = 0; i < 12; i++) put(doc, pages[i % 3], RELAY, 105 + i * 20, 105);
      expect(duplicateRefs(doc).size, scope).toBe(0);
    }
  });

  it("returns '' for pinless, report and junction elements", () => {
    const { doc, pages } = setup([{}]);
    expect(put(doc, pages[0], DECO).info.label ?? "").toBe("");
    expect(put(doc, pages[0], REPORT).info.label ?? "").toBe("");
    expect(put(doc, pages[0], twoPin("j", { name: "volt_junction", prefix: "J" })).info.label ?? "").toBe("");
  });
});

describe("planRenumber", () => {
  function scatter(doc: Doc, page: Page, pts: [number, number][], def = RELAY) {
    doc.numbering.autoOnPlace = false;
    return pts.map(([x, y]) => newElement(doc, page, def, { x, y }));
  }

  it("orders page → column → row and is deterministic", () => {
    const { doc, pages } = setup([{}]);
    const a = scatter(doc, pages[0], [[305, 105], [105, 405], [105, 105], [305, 205]]);
    const b = scatter(doc, pages[1], [[105, 105]]);
    const plan = planRenumber(doc, "all");
    const to = new Map(plan.map((c) => [c.elId, c.to]));
    expect([a[2], a[1], a[0], a[3], b[0]].map((e) => to.get(e.id))).toEqual(["K1", "K2", "K3", "K4", "K5"]);
    expect(planRenumber(doc, "all")).toEqual(plan);
    // array order of the elements does not matter
    pages[0].elements.reverse();
    expect(new Map(planRenumber(doc, "all").map((c) => [c.elId, c.to]))).toEqual(to);
  });

  it("keeps locked references and does not reuse them", () => {
    const { doc, pages } = setup([{}]);
    const els = scatter(doc, pages[0], [[105, 105], [205, 105], [305, 105]]);
    els[2].info.label = "K1";
    els[2].refLocked = true;
    const plan = planRenumber(doc, "all");
    expect(plan.find((c) => c.elId === els[2].id)).toBeUndefined();
    expect(plan.map((c) => c.to)).toEqual(["K2", "K3"]);
  });

  it("onlyEmpty fills blanks without touching or colliding with existing refs", () => {
    const { doc, pages } = setup([{}]);
    const els = scatter(doc, pages[0], [[105, 105], [205, 105], [305, 105], [405, 105]]);
    els[1].info.label = "K1";
    els[3].info.label = "K7";
    const plan = planRenumber(doc, "all", true);
    expect(plan.map((c) => [c.elId, c.to])).toEqual([
      [els[0].id, "K2"],
      [els[2].id, "K3"],
    ]);
  });

  it("only renumbers the requested pages and reserves the others' refs", () => {
    const { doc, pages } = setup([{}]);
    const p1 = scatter(doc, pages[0], [[105, 105]]);
    const p2 = scatter(doc, pages[1], [[105, 105], [205, 105]]);
    p1[0].info.label = "K1";
    const plan = planRenumber(doc, [pages[1].id]);
    expect(plan.every((c) => c.pageId === pages[1].id)).toBe(true);
    expect(plan.map((c) => [c.elId, c.to])).toEqual([
      [p2[0].id, "K2"],
      [p2[1].id, "K3"],
    ]);
  });

  it("page scope with {page} restarts per page", () => {
    const { doc, pages } = setup([{ scope: "page", format: "{page}{prefix}{n:2}" }]);
    scatter(doc, pages[0], [[105, 105], [205, 105]]);
    scatter(doc, pages[1], [[105, 105]]);
    expect(planRenumber(doc, "all").map((c) => c.to)).toEqual(["1K01", "1K02", "2K01"]);
  });

  it("separate counters per prefix; skips pinless / report elements; no change entries for unchanged refs", () => {
    const { doc, pages } = setup([{}]);
    const [k] = scatter(doc, pages[0], [[105, 105]]);
    const [m] = scatter(doc, pages[0], [[205, 105]], MOTOR);
    scatter(doc, pages[0], [[305, 105]], DECO);
    scatter(doc, pages[0], [[405, 105]], REPORT);
    k.info.label = "K1";
    expect(planRenumber(doc, "all")).toEqual([{ pageId: pages[0].id, elId: m.id, from: "", to: "M1" }]);
  });
});

describe("duplicateRefs", () => {
  it("finds duplicates across pages but ignores slave and report elements", () => {
    const { doc, pages } = setup([{}]);
    doc.numbering.autoOnPlace = false;
    const a = newElement(doc, pages[0], RELAY, { x: 105, y: 105 });
    const b = newElement(doc, pages[1], RELAY, { x: 105, y: 105 });
    const s = newElement(doc, pages[1], SLAVE, { x: 205, y: 105 });
    const r1 = newElement(doc, pages[0], REPORT, { x: 305, y: 105 });
    const r2 = newElement(doc, pages[1], REPORT, { x: 305, y: 105 });
    a.info.label = b.info.label = s.info.label = "K1";
    r1.info.label = r2.info.label = "R1";
    const d = duplicateRefs(doc);
    expect([...d.keys()]).toEqual(["K1"]);
    expect(d.get("K1")!.map((x) => x.elId)).toEqual([a.id, b.id]);
    b.info.label = "K2";
    expect(duplicateRefs(doc).size).toBe(0);
  });
});

describe("parseRef", () => {
  it("splits prefix and trailing number", () => {
    expect(parseRef("1K07")).toEqual({ prefix: "1K", n: 7 });
    expect(parseRef("KA")).toBeNull();
  });
});
