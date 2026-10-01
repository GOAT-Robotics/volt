import { describe, expect, it } from "vitest";
import type { Doc } from "../model";
import { newPage } from "../doc";
import { diffDocs, type Change } from "../diff";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import { mkDoc, twoPin } from "./helpers";

function base() {
  const { doc, page } = mkDoc();
  const def = twoPin("relay");
  const a = newElement(doc, page, def, { x: 105, y: 105 });
  const b = newElement(doc, page, def, { x: 105, y: 305 });
  a.info.label = "K1";
  b.info.label = "K2";
  const pa = toScene(a, def.pins[1]), pb = toScene(b, def.pins[0]);
  const w = addWire(page, { k: "pin", el: a.id, pin: "2", p: pa }, { k: "pin", el: b.id, pin: "1", p: pb }, [pa, pb], { label: "L1" })!;
  page.texts.push({ id: "t1", x: 400, y: 400, text: "Note", role: "annotation" });
  return { doc, a, b, w };
}
const clone = (d: Doc): Doc => structuredClone(d);
const find = (cs: Change[], area: Change["area"], kind?: Change["kind"]) => cs.filter((c) => c.area === area && (!kind || c.kind === kind));

describe("diffDocs", () => {
  it("identical docs have no changes", () => {
    const { doc } = base();
    const d = diffDocs(doc, clone(doc));
    expect(d.changes).toEqual([]);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
  });

  it("classifies element added / removed / moved / changed", () => {
    const { doc, a, b } = base();
    const B = clone(doc);
    const pb = B.pages[0];
    pb.elements.find((e) => e.id === a.id)!.x += 20; // moved only
    const eb = pb.elements.find((e) => e.id === b.id)!;
    eb.info.label = "K9"; // changed
    eb.y += 10; // …and moved → still "changed", with a moved detail
    const added = newElement(B, pb, twoPin("relay"), { x: 505, y: 105 });
    const A2 = clone(doc);
    A2.pages[0].elements.push({ ...structuredClone(a), id: "gone" });
    const d = diffDocs(A2, B);
    const els = find(d.changes, "element");
    expect(els.find((c) => c.id === a.id)!.kind).toBe("moved");
    const ch = els.find((c) => c.id === b.id)!;
    expect(ch.kind).toBe("changed");
    expect(ch.details!.some((x) => x.startsWith("label: K2 → K9"))).toBe(true);
    expect(ch.details!.some((x) => x.startsWith("moved"))).toBe(true);
    expect(els.find((c) => c.id === added.id)!.kind).toBe("added");
    expect(els.find((c) => c.id === "gone")!.kind).toBe("removed");
    expect(d.tintB.get(added.id)).toBe("added");
    expect(d.tintA.get("gone")).toBe("removed");
    expect(d.tintA.get(a.id)).toBe("moved");
    expect(d.tintB.get(b.id)).toBe("changed");
  });

  it("orientation and type changes are 'changed'", () => {
    const { doc, a } = base();
    const B = clone(doc);
    const ea = B.pages[0].elements.find((e) => e.id === a.id)!;
    ea.rot = 1;
    const d = diffDocs(doc, B);
    expect(find(d.changes, "element", "changed")[0].details).toContain("orientation");
  });

  it("classifies wires: geometry only → moved, connection / label → changed, added / removed", () => {
    const { doc, w } = base();
    const B = clone(doc);
    const wb = B.pages[0].wires[0];
    wb.pts = [wb.pts[0], { x: 145, y: wb.pts[0].y }, { x: 145, y: wb.pts[1].y }, wb.pts[1]];
    let d = diffDocs(doc, B);
    expect(find(d.changes, "wire")).toMatchObject([{ kind: "moved", id: w.id }]);
    wb.label = "L2";
    d = diffDocs(doc, B);
    expect(find(d.changes, "wire")).toMatchObject([{ kind: "changed", id: w.id }]);
    expect(find(d.changes, "wire")[0].details).toContain("label: L1 → L2");
    wb.b = { k: "free" };
    d = diffDocs(doc, B);
    expect(find(d.changes, "wire")[0].details).toContain("connection changed");
    B.pages[0].wires.push({ ...structuredClone(wb), id: "w-new" });
    B.pages[0].wires = B.pages[0].wires.filter((x) => x.id !== w.id);
    d = diffDocs(doc, B);
    expect(find(d.changes, "wire").map((c) => [c.id, c.kind]).sort()).toEqual([
      ["w-new", "added"],
      [w.id, "removed"],
    ].sort());
  });

  it("classifies free texts", () => {
    const { doc } = base();
    const B = clone(doc);
    B.pages[0].texts[0].text = "Changed";
    B.pages[0].texts.push({ id: "t2", x: 0, y: 0, text: "New", role: "annotation" });
    const A = clone(doc);
    A.pages[0].texts.push({ id: "t0", x: 0, y: 0, text: "Old", role: "annotation" });
    const d = diffDocs(A, B);
    expect(find(d.changes, "text").map((c) => [c.id, c.kind]).sort()).toEqual([
      ["t0", "removed"],
      ["t1", "changed"],
      ["t2", "added"],
    ]);
  });

  it("classifies pages: added, removed, renamed, reordered", () => {
    const { doc } = base();
    doc.pages.push(newPage(1, "Second"));
    const B = clone(doc);
    B.pages[0].title = "Renamed";
    const extra = newPage(2, "Third");
    B.pages.push(extra);
    let d = diffDocs(doc, B);
    expect(find(d.changes, "page", "added")).toMatchObject([{ pageId: extra.id }]);
    expect(find(d.changes, "page", "changed").map((c) => c.label)).toContain("Page renamed");
    d = diffDocs(B, doc);
    expect(find(d.changes, "page", "removed")).toMatchObject([{ pageId: extra.id }]);
    const C = clone(doc);
    C.pages[0].order = 1;
    C.pages[1].order = 0;
    expect(find(diffDocs(doc, C).changes, "page").map((c) => c.label)).toEqual(["Page order changed"]);
    // elements of an added page are tinted
    newElement(B, extra, twoPin("relay"), { x: 105, y: 105 });
    d = diffDocs(doc, B);
    expect([...d.tintB.values()]).toContain("added");
  });

  it("detects style changes (project and organization base)", () => {
    const { doc } = base();
    const B = clone(doc);
    B.styles = { text: { componentRef: { size: 14 } } };
    let d = diffDocs(doc, B);
    expect(find(d.changes, "style")).toHaveLength(1);
    expect(find(d.changes, "style")[0].details).toEqual(["text.componentRef"]);
    const C = clone(doc);
    C.baseStyles.graphics.wire.color = "#ff0000";
    d = diffDocs(doc, C);
    expect(find(d.changes, "style")[0].details).toContain("organization template");
  });

  it("detects title block changes", () => {
    const { doc } = base();
    const B = clone(doc);
    B.pages[0].titleBlock.fields.author = "Jane Doe";
    let d = diffDocs(doc, B);
    const tb = find(d.changes, "titleblock");
    expect(tb).toHaveLength(1);
    expect(tb[0].details).toEqual(["author: ∅ → Jane Doe"]);
    const C = clone(doc);
    C.pages[0].titleBlock.template = "other";
    d = diffDocs(doc, C);
    expect(find(d.changes, "titleblock")).toHaveLength(1);
  });

  it("detects project meta, numbering, definitions and junction changes", () => {
    const { doc } = base();
    const B = clone(doc);
    B.meta.title = "New";
    B.meta.props.client = "ACME";
    B.numbering.autoOnPlace = true;
    Object.values(B.defs)[0].pins[0].number = "A1";
    B.pages[0].junctions.push({ id: "j", x: 0, y: 0 });
    const d = diffDocs(doc, B);
    const labels = d.changes.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["Project title", "Project properties", "Numbering rules"]));
    expect(find(d.changes, "definition")).toHaveLength(1);
    expect(find(d.changes, "junction", "added")).toHaveLength(1);
    expect(d.summary.changed + d.summary.added).toBe(d.changes.length);
  });
});
