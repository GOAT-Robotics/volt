import { describe, expect, it } from "vitest";
import { encodeJob, headArea, mmToDots, packBits, parseStatus, unpackBits, type PtBitmap } from "../ptouch";
import { labelRecords, layoutLabel, MEDIA, detailLine, type LabelContent } from "../labels";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import { mkDoc, twoPin } from "./helpers";

describe("PackBits", () => {
  it("round-trips and compresses runs", () => {
    const cases = [new Uint8Array(16), Uint8Array.from([1, 2, 3, 4, 5]), Uint8Array.from([0, 0, 0, 7, 7, 1, 2, 2, 2, 2, 9]), Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff)];
    for (const c of cases) expect([...unpackBits(packBits(c))]).toEqual([...c]);
    expect(packBits(new Uint8Array(16)).length).toBe(2);
  });
});

describe("P-touch raster job", () => {
  const bmp = (length: number, pins: number, f: (x: number, y: number) => boolean): PtBitmap => {
    const bits = new Uint8Array(length * pins);
    for (let x = 0; x < length; x++) for (let y = 0; y < pins; y++) bits[x * pins + y] = f(x, y) ? 1 : 0;
    return { length, pins, bits };
  };
  it("has the command structure of the raster reference", () => {
    const a = headArea(12, false);
    expect(a).toEqual({ pins: 70, left: 29 });
    const job = encodeJob({ labels: [bmp(10, 70, (x) => x === 3), bmp(5, 70, () => false)], mediaType: 0x01, widthMm: 12, autoCut: true, halfCut: false, feedDots: 14 });
    const b = [...job];
    expect(b.slice(0, 100).every((x) => x === 0)).toBe(true);
    expect(b.slice(100, 106)).toEqual([0x1b, 0x40, 0x1b, 0x69, 0x61, 0x01]);
    // print information for the first label: 10 raster lines, starting page
    expect(b.slice(106, 119)).toEqual([0x1b, 0x69, 0x7a, 0x86, 0x01, 12, 0, 10, 0, 0, 0, 0, 0]);
    expect(b[b.length - 1]).toBe(0x1a); // print with feed at the end
    expect(b.filter((x, i) => x === 0x0c && b[i - 1] === 0x5a).length).toBe(1); // form feed after the first label's last (zero) line
    // the one black column: compressed raster line with pins 29..98 set
    const g = b.indexOf(0x47);
    const len = b[g + 1];
    const line = unpackBits(Uint8Array.from(b.slice(g + 3, g + 3 + len)));
    expect(line.length).toBe(16);
    const pins = [...Array(128).keys()].filter((p) => line[p >> 3] & (0x80 >> (p & 7)));
    expect(pins[0]).toBe(29);
    expect(pins.length).toBe(70);
  });
  it("reads the status reply", () => {
    const r = new Uint8Array(32);
    r[0] = 0x80;
    r[10] = 12;
    r[11] = 0x11;
    r[9] = 0x10;
    expect(parseStatus(r)).toMatchObject({ mediaWidth: 12, mediaType: 0x11, errors: ["Cover open"] });
  });
  it("dots", () => expect(mmToDots(25.4)).toBe(180));
});

describe("wire labels", () => {
  function doc() {
    const { doc, page } = mkDoc();
    const a = newElement(doc, page, twoPin("r"), { x: 105, y: 105 });
    const b = newElement(doc, page, twoPin("r"), { x: 305, y: 305 });
    a.info.label = "K1";
    b.info.label = "F1";
    const p1 = toScene(a, doc.defs[a.defId].pins[1]), p2 = toScene(b, doc.defs[b.defId].pins[0]);
    addWire(page, { k: "pin", el: a.id, pin: "2", p: p1 }, { k: "pin", el: b.id, pin: "1", p: p2 }, [p1, { x: p1.x, y: p2.y }, p2], { label: "B012A", section: "0.5 mm²", insulation: "BU" });
    return doc;
  }
  const content: LabelContent = { perEnd: true, detail: "route", conductor: true, includeUnnumbered: false };
  it("one label per end with route", () => {
    const r = labelRecords(doc(), { content });
    expect(r.map((x) => [x.id, x.end, x.here, x.there])).toEqual([
      ["B012A", "a", "K1:2", "F1:1"],
      ["B012A", "b", "F1:1", "K1:2"],
    ]);
    expect(detailLine(r[0], content)).toBe("K1:2 → F1:1  BU 0.5 mm²");
  });
  it("lays out heat-shrink, flag and wrap labels", () => {
    const r = labelRecords(doc(), { content })[0];
    const hs = layoutLabel(r, content, { media: MEDIA.find((m) => m.id === "hse-231")!, length: 0, wireDiameter: 2, repeat: 2, margin: 2 });
    expect(hs.items.filter((i) => i.bold).length).toBe(2);
    const flag = layoutLabel(r, content, { media: MEDIA.find((m) => m.kind === "flag" && m.width === 12)!, length: 0, wireDiameter: 3, repeat: 1, margin: 2, flagTurn: true });
    expect(flag.items.some((i) => i.rot180)).toBe(true);
    expect(flag.cutMarks.length).toBe(2);
    const fixed = layoutLabel(r, content, { media: MEDIA.find((m) => m.id === "tze-12")!, length: 20, wireDiameter: 2, repeat: 1, margin: 1 });
    expect(fixed.length).toBe(20);
  });
});
