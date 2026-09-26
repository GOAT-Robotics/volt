import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName, PDFArray } from "pdf-lib";
import { importQet } from "../qet/project";
import { buildXref, targetsOf, occurrenceAt, gridRef } from "../xref";
import { approxMeasure } from "../render/svg";
import { exportPdf } from "../render/pdf";

const FIX = path.join(__dirname, "../qet/__fixtures__/projects");
const load = (f: string) => importQet(readFileSync(path.join(FIX, f), "utf8"), f).doc;

describe("cross references", () => {
  const doc = load("2612_ats_singlephase.qet");
  const x = buildXref(doc, approxMeasure);

  it("groups labels that appear more than once", () => {
    expect(x.groups.length).toBeGreaterThan(0);
    for (const g of x.groups) expect(g.length).toBeGreaterThan(1);
  });

  it("targets cycle through every other member of the group", () => {
    const g = x.groups[0];
    const o = x.occ[g[0]];
    const t = targetsOf(x, o);
    expect(t).toHaveLength(g.length - 1);
    expect(t.map((q) => q.idx)).not.toContain(o.idx);
  });

  it("finds the occurrence under its label", () => {
    const o = x.occ[x.groups[0][0]];
    const c = { x: o.rect.x + o.rect.w / 2, y: o.rect.y + o.rect.h / 2 };
    expect(occurrenceAt(x, o.pageId, c)?.group).toBe(o.group);
  });

  it("follows explicit QElectroTech links (folio reports / master-slave)", () => {
    for (const f of ["2612_ats_singlephase.qet"]) {
      const d = load(f);
      const linked = d.pages.flatMap((p) => p.elements).filter((e) => e.links?.length);
      expect(linked.length).toBeGreaterThan(0);
      const xx = buildXref(d, approxMeasure);
      const o = xx.occ.find((q) => q.id === linked[0].id)!;
      expect(o.group).toBeGreaterThanOrEqual(0);
      const ids = targetsOf(xx, o).map((q) => q.id);
      expect(linked[0].links!.some((l) => ids.includes(l))).toBe(true);
    }
  });

  it("computes QET-style grid references", () => {
    const p = doc.pages[0];
    expect(gridRef(doc, p, { x: p.border.headerW + 1, y: p.border.headerH + 1 })).toBe("1A");
  });

  it("PDF export contains internal link annotations", async () => {
    const pages = [...doc.pages].sort((a, b) => a.order - b.order);
    const count = async (bytes: Uint8Array) => {
      const pdf = await PDFDocument.load(bytes);
      let n = 0;
      for (const p of pdf.getPages()) {
        const a = p.node.lookup(PDFName.of("Annots"));
        if (a instanceof PDFArray) n += a.size();
      }
      return n;
    };
    expect(await count(await exportPdf(doc, { pages, paper: "A3" }))).toBeGreaterThan(0);
    expect(await count(await exportPdf(doc, { pages, paper: "A3", links: false }))).toBe(0);
  });
});
