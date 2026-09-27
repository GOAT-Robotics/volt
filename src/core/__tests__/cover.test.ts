import { describe, expect, it } from "vitest";
import { newDoc } from "../doc";
import { coverFromPageTexts } from "../render/cover";
import { pageToSvg } from "../render/svg";

const TYPED = `Name : Conveyor Panel
Model Number : CP-100
Battery Specification : 24V 7Ah
Charging Specification : 27.6V 2A
o   Full Load Current : --A
o    Document Number : EX-EL-CP-SC-001
o    Issue Date : 
o   Revision Number : v1.5
o    Name and Address of Manufacturer :
            EXAMPLE COMPANY
            12 Sample Street,
            Springfield 12345
            India.`;

describe("cover sheet", () => {
  it("takes over a hand-typed cover", () => {
    const d = newDoc("CP");
    d.pages[0].texts.push({ id: "t1", x: 50, y: 50, text: TYPED, role: "annotation" });
    const { cover, used } = coverFromPageTexts(d.pages[0]);
    expect(cover.title).toBe("Conveyor Panel");
    expect(cover.fields.map((f) => f.label)).toEqual(["Product", "Model Number", "Battery Specification", "Charging Specification", "Full Load Current", "Document Number", "Issue Date", "Revision Number"]);
    expect(cover.fields[5].value).toBe("EX-EL-CP-SC-001");
    expect(cover.manufacturer).toBe("EXAMPLE COMPANY\n12 Sample Street,\nSpringfield 12345\nIndia.");
    expect(used).toEqual(["t1"]);
  });

  it("renders cover and contents sheets", () => {
    const d = newDoc("CP");
    d.pages[0].kind = "cover";
    d.pages[0].cover = { fields: [{ label: "Model number", value: "CP-100" }], manufacturer: "EXAMPLE COMPANY\nSpringfield", showRevisions: true };
    d.revisions = [{ rev: "1.5", date: "2026-09-27", description: "CE file", drawn: "SU", checked: "NS", approved: "MS" }];
    const svg = pageToSvg(d, d.pages[0]);
    for (const s of ["CP-100", "MANUFACTURER", "REVISION HISTORY", "CE file", "EXAMPLE COMPANY"]) expect(svg).toContain(s);
    d.pages[0].kind = "contents";
    expect(pageToSvg(d, d.pages[0])).toContain("Table of contents");
  });
});

describe("pictures on pages", () => {
  it("draws an image shape fitted in its box", () => {
    const d = newDoc("p");
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8AARAwMDAwMAD/5A/1m0ZfpAAAAAElFTkSuQmCC";
    d.pages[0].shapes.push({ id: "s", kind: "rect", pts: [{ x: 0, y: 0 }, { x: 300, y: 100 }], color: "#000", width: 0, dash: "solid", fill: null, image: { type: "png", data: PNG } });
    const svg = pageToSvg(d, d.pages[0]);
    expect(svg).toMatch(/<image x="75" y="0" width="150" height="100"/);
  });
});
