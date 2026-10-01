import { afterEach, describe, expect, it } from "vitest";
import { newDoc } from "../doc";
import { newCover } from "../render/cover";
import { pageToSvg } from "../render/svg";
import { brand, setBrand } from "../brand";

const LOGO = { type: "svg" as const, data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>').toString("base64") };

describe("organization branding", () => {
  afterEach(() => setBrand(null));

  it("is empty by default: no logo, no manufacturer", () => {
    expect(brand()).toEqual({ name: "", address: "", logo: null });
    expect(newCover().manufacturer).toBe("");
    const d = newDoc("T");
    d.pages[0].kind = "cover";
    d.pages[0].cover = newCover();
    expect(pageToSvg(d, d.pages[0])).not.toContain("<image");
  });

  it("fills new cover sheets and draws the logo", () => {
    setBrand({ name: "Acme Controls", address: "1 Test Road\nSpringfield", logo: LOGO });
    const c = newCover();
    expect(c.manufacturer).toBe("Acme Controls\n1 Test Road\nSpringfield");
    const d = newDoc("T");
    d.pages[0].kind = "cover";
    d.pages[0].cover = c;
    const svg = pageToSvg(d, d.pages[0]);
    expect(svg).toContain(LOGO.data);
    // hidden per cover sheet
    d.pages[0].cover = { ...c, logo: null };
    expect(pageToSvg(d, d.pages[0])).not.toContain(LOGO.data);
  });
});
