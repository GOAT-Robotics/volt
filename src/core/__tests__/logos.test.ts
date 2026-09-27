import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTitleBlockTemplate, serializeTitleBlockTemplate, titleBlockModified, templateLogos } from "../qet/titleblock";
import { base64ToText, fitContain, logoSize } from "../logos";
import { newDoc } from "../doc";
import { pageToSvg } from "../render/svg";
import { exportPdf } from "../render/pdf";
import { PDFDocument } from "pdf-lib";

const seed = (f: string) => readFileSync(path.join(__dirname, "../../../seed/titleblocks", f), "utf8");
// 3×2 red PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8AARAwMDAwMAD/5A/1m0ZfpAAAAAElFTkSuQmCC";

describe("title block logos", () => {
  it("parses SVG (xml storage) and JPEG (base64) logos used by cells", () => {
    const t = parseTitleBlockTemplate(seed("double-logo.titleblock"));
    expect(t.logos).toBeUndefined(); // kept in the xml
    const tl = templateLogos(t);
    expect(Object.keys(tl)).toEqual(["qelectrotech.svg"]);
    expect(tl["qelectrotech.svg"].type).toBe("svg");
    expect(base64ToText(tl["qelectrotech.svg"].data)).toMatch(/^<svg/);
    expect(logoSize(tl["qelectrotech.svg"])!.w).toBeGreaterThan(0);
    const a = parseTitleBlockTemplate(seed("Societe-pour-Alstom2.titleblock"));
    const al = templateLogos(a);
    expect(Object.keys(al).sort()).toEqual(["9-alstom.jpg", "Vue iso.JPG"]);
    const s = logoSize(al["9-alstom.jpg"])!;
    expect(s.w).toBeGreaterThan(10);
    expect(s.h).toBeGreaterThan(10);
    // unchanged templates export byte for byte
    expect(serializeTitleBlockTemplate(t)).toBe(seed("double-logo.titleblock"));
    expect(titleBlockModified(t)).toBe(false);
  });


  it("replaces a logo and writes it back into <logos>", () => {
    const t = parseTitleBlockTemplate(seed("double-logo.titleblock"));
    const cell = t.cells.find((c) => c.type === "logo" && c.col === 4)!;
    cell.value = "ours.png";
    t.logos = { ...templateLogos(t), "ours.png": { type: "png", data: PNG } };
    expect(logoSize(t.logos["ours.png"])).toEqual({ w: 3, h: 2 });
    const out = serializeTitleBlockTemplate(t);
    const again = parseTitleBlockTemplate(out);
    expect(templateLogos(again)["ours.png"]).toEqual({ type: "png", data: PNG });
    expect(templateLogos(again)["qelectrotech.svg"].type).toBe("svg");
    expect(titleBlockModified({ ...again, xml: out })).toBe(false);
    // a logo no cell uses any more is dropped
    again.cells.find((c) => c.type === "logo" && c.col === 0)!.value = "ours.png";
    again.logos = { "ours.png": templateLogos(again)["ours.png"] };
    expect(serializeTitleBlockTemplate(again)).not.toContain("qelectrotech.svg");
    expect(again.cells.find((c) => c.type === "logo" && c.col === 4)!.value).toBe("ours.png");
  });

  it("fits a logo inside its cell", () => {
    expect(fitContain({ w: 200, h: 100 }, { x: 0, y: 0, w: 54, h: 54 }, 2)).toEqual({ x: 2, y: 14.5, w: 50, h: 25 });
  });

  it("draws logos in SVG and PDF exports", async () => {
    const doc = newDoc("Logo test");
    const t = parseTitleBlockTemplate(seed("double-logo.titleblock"));
    t.cells.find((c) => c.type === "logo" && c.col === 4)!.value = "ours.png";
    t.logos = { ...templateLogos(t), "ours.png": { type: "png", data: PNG } };
    doc.titleBlocks[t.name] = t;
    doc.pages[0].titleBlock.template = t.name;
    doc.pages[0].titleBlock.show = true;
    const svg = pageToSvg(doc, doc.pages[0]);
    expect(svg.match(/<image /g)?.length).toBe(2);
    expect(svg).toContain("data:image/png;base64," + PNG);
    const pdf = await PDFDocument.load(await exportPdf(doc, { pages: doc.pages, paper: "A4" }));
    const xobjs = pdf.getPages()[0].node.Resources()!.lookup(pdf.context.obj("XObject") as never);
    expect(String(xobjs)).toContain("/Img");
  });
});

describe("renaming a template keeps its logos", () => {
  it("serialises under a new name with logos intact", () => {
    const t = parseTitleBlockTemplate(seed("double-logo.titleblock"));
    const out = serializeTitleBlockTemplate({ ...t, name: "Renamed", logos: templateLogos(t) });
    const again = parseTitleBlockTemplate(out);
    expect(again.name).toBe("Renamed");
    expect(Object.keys(templateLogos(again))).toEqual(["qelectrotech.svg"]);
  });
});
