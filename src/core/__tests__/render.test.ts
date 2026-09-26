import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { PDFDocument } from "pdf-lib";
import type { Doc, Page } from "../model";
import { importQet } from "../qet";
import { drawPage, layoutElementTexts, docStyles, textBounds } from "../render/scene";
import { SvgPainter, pageToSvg, approxMeasure } from "../render/svg";
import { exportPdf } from "../render/pdf";
import { pageToDxf } from "../render/dxf";
import { symbolFor } from "../render/symbol";
import type { Painter } from "../render/painter";
import { newElement } from "../ops";
import { FIX, fixtureDef, mkDoc, readFixtureQet, twoPin } from "./helpers";

const qetFiles = readdirSync(path.join(FIX, "projects")).filter((f) => f.endsWith(".qet"));
const docs = new Map<string, Doc>();
const load = (f: string) => {
  if (!docs.has(f)) docs.set(f, importQet(readFixtureQet(f), f).doc);
  return docs.get(f)!;
};
const sortedPages = (d: Doc) => [...d.pages].sort((a, b) => a.order - b.order);

function parseXmlStrict(s: string) {
  const errors: string[] = [];
  const dom = new DOMParser({ onError: (level, msg) => void (level !== "warning" && errors.push(msg)) }).parseFromString(s, "image/svg+xml");
  return { dom, errors };
}

describe.each(qetFiles)("render %s", (file) => {
  it("drawPage into SvgPainter works on every page and emits paths", () => {
    const doc = load(file);
    expect(doc.pages.length).toBeGreaterThan(0);
    for (const page of doc.pages) {
      const p = new SvgPainter();
      expect(() => drawPage(p, { doc, page, lod: 100 })).not.toThrow();
      const paths = p.out.filter((l) => l.startsWith("<path")).length;
      expect(paths, page.title).toBeGreaterThan(0);
      // every opened group is closed
      const opens = p.out.filter((l) => l.startsWith("<g")).length;
      const closes = p.out.filter((l) => l === "</g>").length;
      expect(opens).toBe(closes);
      expect(p.out.join("")).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it("pageToSvg is well-formed XML with an svg root", () => {
    const doc = load(file);
    for (const page of doc.pages) {
      const svg = pageToSvg(doc, page, { background: "#ffffff" });
      const { dom, errors } = parseXmlStrict(svg);
      expect(errors, page.title).toEqual([]);
      expect(dom.documentElement!.nodeName).toBe("svg");
      expect(dom.getElementsByTagName("path").length).toBeGreaterThan(0);
      expect(dom.documentElement!.getAttribute("viewBox")!.split(" ").map(Number).every(Number.isFinite)).toBe(true);
    }
  });

  it("pageToDxf has balanced sections and an ENTITIES section", () => {
    const doc = load(file);
    for (const page of doc.pages) {
      const dxf = pageToDxf(doc, page);
      const lines = dxf.split("\n");
      const count = (v: string) => lines.filter((l, i) => l === v && lines[i - 1] === "0").length;
      expect(count("SECTION")).toBe(count("ENDSEC"));
      expect(count("SECTION")).toBe(3);
      expect(dxf).toMatch(/\n2\nENTITIES\n/);
      expect(count("POLYLINE")).toBe(count("SEQEND"));
      expect(count("LINE") + count("POLYLINE")).toBeGreaterThan(0);
      expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
      expect(dxf).not.toMatch(/NaN|undefined/);
    }
  });

  it("exportPdf produces a reloadable PDF with one page per drawing page", async () => {
    const doc = load(file);
    const pages = sortedPages(doc);
    const bytes = await exportPdf(doc, { pages, paper: "A3", title: "T" });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const re = await PDFDocument.load(bytes);
    expect(re.getPageCount()).toBe(pages.length);
    expect(re.getTitle()).toBe("T");
  });
});

describe("exportPdf options", () => {
  const file = qetFiles.find((f) => f.startsWith("schema_indus")) ?? qetFiles[0];
  it("deterministic mode yields identical bytes twice", async () => {
    const doc = load(file);
    const pages = sortedPages(doc);
    const a = await exportPdf(doc, { pages, paper: "A4", deterministic: true, version: "A.1" });
    await new Promise((r) => setTimeout(r, 15));
    const b = await exportPdf(doc, { pages, paper: "A4", deterministic: true, version: "A.1" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
  it("fit paper sizes the page to the drawing and subsets work", async () => {
    const doc = load(file);
    const page = sortedPages(doc)[0];
    const bytes = await exportPdf(doc, { pages: [page], paper: "fit", margin: 10 });
    const re = await PDFDocument.load(bytes);
    expect(re.getPageCount()).toBe(1);
    const { width, height } = re.getPage(0).getSize();
    expect(width).toBeGreaterThan(20);
    expect(height).toBeGreaterThan(20);
  });
});

describe("readable text rule", () => {
  it("layoutElementTexts never returns a rotation in (45, 225]", () => {
    const { doc, page } = mkDoc();
    const defs = [twoPin("relay"), fixtureDef("bobine3.elmt"), fixtureDef("moteur_tri_de.elmt"), fixtureDef("disjonct-m_4fn.elmt")];
    let checked = 0;
    for (const def of defs)
      for (const rot of [0, 1, 2, 3] as const)
        for (const mirror of [false, true])
          for (const styleRot of [0, 30, 90, 135, 180, 200, 270, 315]) {
            const e = newElement(doc, page, def, { x: 105, y: 105 }, rot, mirror);
            e.info.label = "K12";
            e.info.comment = "Comment";
            e.info.function = "fn";
            for (const t of e.texts) t.override = { rotation: styleRot };
            const laid = layoutElementTexts(e, symbolFor(def), docStyles(doc), approxMeasure);
            for (const t of laid) {
              const r = ((t.rotation % 360) + 360) % 360;
              expect(r > 45 && r <= 225, JSON.stringify({ def: def.id, rot, mirror, styleRot, r })).toBe(false);
              const b = textBounds(t);
              expect([b.x, b.y, b.w, b.h].every(Number.isFinite)).toBe(true);
              checked++;
            }
          }
    expect(checked).toBeGreaterThan(100);
  });
});

