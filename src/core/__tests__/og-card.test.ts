import { describe, it, expect } from "vitest";
import { cardSvg, nestSvg, svgAspect, wrap } from "@/lib/og/card";
import { schematicArt } from "@/lib/brand/schematic";

describe("link preview cards", () => {
  it("wrap long titles and end with an ellipsis", () => {
    const lines = wrap("Automatic transfer switch panel for the CP two thousand autonomous mobile robot fleet charging bay", 44, 400, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith("…")).toBe(true);
    expect(wrap("Short", 44, 400, 3)).toEqual(["Short"]);
    // a word wider than the column is broken
    expect(wrap("EX-EL-CP-SC-001-EX-EL-CP-SC-001-GR-CE-AMR", 44, 200, 4).length).toBeGreaterThan(1);
  });

  it("nest a drawing without its XML declaration", () => {
    const doc = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><title>x</title><rect width="10" height="10"/></svg>`;
    expect(svgAspect(doc)).toBe(2);
    const n = nestSvg(doc, 10, 20, 300, 150);
    expect(n).toContain('viewBox="0 0 400 200"');
    expect(n).not.toContain("<?xml");
    expect(n).not.toContain("<title>");
  });

  it("escape user text", () => {
    const svg = cardSvg({ kicker: "Project", title: "A <b> & \"C\"", lines: ["<script>"] });
    expect(svg).toContain("A &lt;b&gt; &amp; &quot;C&quot;");
    expect(svg).not.toContain("<script>");
  });

  it("schematic art is deterministic", () => {
    const a = schematicArt({ width: 800, height: 500, seed: 3 });
    expect(a).toBe(schematicArt({ width: 800, height: 500, seed: 3 }));
    expect(a).not.toBe(schematicArt({ width: 800, height: 500, seed: 4 }));
    expect(a).toContain("3~");
  });
});
