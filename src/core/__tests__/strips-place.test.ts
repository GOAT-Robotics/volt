import { describe, expect, it } from "vitest";
import { newElement } from "../ops";
import { newPage } from "../doc";
import { assignToStrip, builtinTerminalDef, collectStrips, createStrip, parseTerminalRef, placeTerminalsOnSheets, sheetCapacity, stripSheets } from "../terminals";
import { autoLinkReports, linkReports, reportTarget, unlinkReport } from "../reports";
import { duplicateRefs } from "../numbering";
import { checkElectrical } from "../erc";
import { mkDef, mkDoc } from "./helpers";

describe("terminal strips on the drawing", () => {
  it("a bare number is a terminal without a strip, not a strip of its own", () => {
    expect(parseTerminalRef("12")).toEqual({ tag: "", num: "12", sep: ":" });
    expect(parseTerminalRef("X1:12").tag).toBe("X1");
  });

  it("creates a strip with N terminals and places them in series", () => {
    const { doc, page } = mkDoc();
    createStrip(doc, "X1", 10);
    expect(collectStrips(doc).find((v) => v.tag === "X1")!.rows.every((r) => r.spare)).toBe(true);
    const def = builtinTerminalDef();
    const { ids, pages } = placeTerminalsOnSheets(doc, page.id, "X1", Array.from({ length: 10 }, (_, i) => String(i + 1)), def, { perSheet: 50, newElement, newPage });
    expect(ids.length).toBe(10);
    expect(pages).toEqual([page.id]);
    const els = page.elements.filter((e) => ids.includes(e.id));
    expect(els.map((e) => e.info.label)).toEqual(Array.from({ length: 10 }, (_, i) => `X1:${i + 1}`));
    // in series, evenly spaced, one row
    expect(new Set(els.map((e) => e.y)).size).toBe(1);
    const dx = els.slice(1).map((e, i) => e.x - els[i].x);
    expect(new Set(dx).size).toBe(1);
    const v = collectStrips(doc).find((x) => x.tag === "X1")!;
    expect(v.rows.length).toBe(10);
    expect(v.rows.some((r) => r.spare)).toBe(false);
    expect(stripSheets(v)).toEqual([{ sheet: 1, pageId: page.id, count: 10 }]);
  });

  it("splits a long strip over new sheets after the current one", () => {
    const { doc, page } = mkDoc();
    const after = newPage(1, "After");
    doc.pages.push(after);
    const def = builtinTerminalDef();
    expect(sheetCapacity(page, def, "h")).toBeGreaterThan(10);
    const { ids, pages } = placeTerminalsOnSheets(doc, page.id, "X5", Array.from({ length: 45 }, (_, i) => String(i + 1)), def, { perSheet: 20, newElement, newPage });
    expect(ids.length).toBe(45);
    expect(pages.length).toBe(3);
    const sorted = [...doc.pages].sort((a, b) => a.order - b.order).map((p) => p.title);
    expect(sorted).toEqual([page.title, "X5 terminals 2/3", "X5 terminals 3/3", "After"]);
    const v = collectStrips(doc).find((x) => x.tag === "X5")!;
    expect(stripSheets(v).map((s) => s.count)).toEqual([20, 20, 5]);
  });

  it("puts bare-numbered terminals into a strip, keeping free numbers", () => {
    const { doc, page } = mkDoc();
    const def = builtinTerminalDef();
    const a = newElement(doc, page, def, { x: 100, y: 100 });
    const b = newElement(doc, page, def, { x: 120, y: 100 });
    a.info.label = "3";
    b.info.label = "7";
    const none = collectStrips(doc).find((v) => v.tag === "")!;
    expect(none.rows.length).toBe(2);
    assignToStrip(doc, "", none.rows.map((r) => r.key), "X2");
    expect([a.info.label, b.info.label]).toEqual(["X2:3", "X2:7"]);
  });
});

describe("folio reports", () => {
  const going = mkDef("go", [{ id: "1", x: -10, y: 0, orient: "w" }], { linkType: "next_report", name: "report_go" });
  const coming = mkDef("come", [{ id: "1", x: 10, y: 0, orient: "e" }], { linkType: "previous_report", name: "report_come" });
  function two() {
    const { doc, page } = mkDoc();
    const p2 = newPage(1, "Sheet 2");
    p2.border = { ...page.border };
    doc.pages.push(p2);
    const g = newElement(doc, page, going, { x: 400, y: 100 });
    const c1 = newElement(doc, p2, coming, { x: 100, y: 100 });
    const c2 = newElement(doc, p2, coming, { x: 100, y: 300 });
    return { doc, page, p2, g, c1, c2 };
  }
  it("same reference on going and coming arrows is allowed and links them", () => {
    const { doc, g, c1, c2 } = two();
    g.info.label = c1.info.label = "24V";
    c2.info.label = "5V";
    expect(duplicateRefs(doc).size).toBe(0);
    expect(autoLinkReports(doc)).toBe(1);
    expect(g.links).toEqual([c1.id]);
    expect(c1.links).toEqual([g.id]);
    expect(c2.links).toBeUndefined();
    expect(reportTarget(doc, g)).toMatch(/^2-\d+[A-Z]$/);
    expect(checkElectrical(doc).filter((i) => i.code === "erc.reportOpen").map((i) => i.ids?.[0])).toEqual([c2.id]);
  });
  it("one going arrow feeds several coming arrows; unlink both ways", () => {
    const { doc, g, c1, c2 } = two();
    g.info.label = c1.info.label = c2.info.label = "PE";
    expect(autoLinkReports(doc)).toBe(2);
    expect(g.links?.sort()).toEqual([c1.id, c2.id].sort());
    unlinkReport(doc, g.id, c1.id);
    expect(g.links).toEqual([c2.id]);
    expect(c1.links).toBeUndefined();
    linkReports(doc, g.id, c1.id);
    expect(c1.links).toEqual([g.id]);
  });
});
