import { describe, expect, it } from "vitest";
import { bundledFamily, canvasFont } from "../render/drawing-fonts";

describe("drawing fonts", () => {
  it("maps every style font to an app-served family", () => {
    expect(bundledFamily("ISOCPEUR, Arial, sans-serif")).toBe("Volt ISO");
    expect(bundledFamily("isocpeur")).toBe("Volt ISO");
    expect(bundledFamily("Arial, sans-serif")).toBe("Volt Sans");
    expect(bundledFamily("Helvetica, Arial, sans-serif")).toBe("Volt Sans");
    expect(bundledFamily("Inter, Helvetica, Arial, sans-serif")).toBe("Volt Sans");
    expect(bundledFamily("DejaVu Sans, sans-serif")).toBe("Volt Sans");
    expect(bundledFamily("Georgia, serif")).toBe("Volt Serif");
    expect(bundledFamily("Times New Roman, serif")).toBe("Volt Serif");
    expect(bundledFamily("Courier New, monospace")).toBe("Volt Mono");
    expect(bundledFamily('"DejaVu Sans Mono"')).toBe("Volt Mono");
  });
  it("skips unknown names and falls back to the sans family", () => {
    expect(bundledFamily("Wingdings Fancy, Georgia")).toBe("Volt Serif");
    expect(bundledFamily("Some Font")).toBe("Volt Sans");
    expect(bundledFamily("")).toBe("Volt Sans");
  });
  it("never hands the canvas a local font name", () => {
    expect(canvasFont(9, "ISOCPEUR, Arial, sans-serif", 700, true)).toBe('italic 700 9px "Volt ISO"');
  });
});
