import { describe, expect, it } from "vitest";
import { CanvasPainter } from "../render/canvas";

/** A 2D context stand-in that keeps a font stack like a real one: restore() brings the saved font back. */
function fakeCtx() {
  const stack: string[] = [];
  const drawn: { text: string; font: string }[] = [];
  const ctx = {
    font: "10px sans-serif",
    save() {
      stack.push(this.font);
    },
    restore() {
      this.font = stack.pop() ?? this.font;
    },
    setTransform() {},
    transform() {},
    fillText(text: string) {
      drawn.push({ text, font: this.font });
    },
  };
  return { ctx, drawn };
}

describe("CanvasPainter fonts", () => {
  it("sets the font again after restore() put an older one back", () => {
    const { ctx, drawn } = fakeCtx();
    const pt = new CanvasPainter(ctx as unknown as CanvasRenderingContext2D, [1, 0, 0, 1, 0, 0]);
    const draw = (text: string) => {
      pt.save();
      pt.text({ text, x: 0, y: 0, size: 9, font: "ISOCPEUR, Arial, sans-serif", color: "#000" });
      pt.restore();
    };
    draw("Inverter");
    draw("Emergency");
    expect(drawn.map((d) => d.font)).toEqual(['400 9px "Volt ISO"', '400 9px "Volt ISO"']);
  });

  it("sets the font again after other code changed it on the same context", () => {
    const { ctx, drawn } = fakeCtx();
    const pt = new CanvasPainter(ctx as unknown as CanvasRenderingContext2D, [1, 0, 0, 1, 0, 0]);
    pt.text({ text: "A", x: 0, y: 0, size: 9, font: "Arial", color: "#000" });
    ctx.font = "500 11px ui-sans-serif";
    pt.text({ text: "B", x: 0, y: 0, size: 9, font: "Arial", color: "#000" });
    expect(drawn[1].font).toBe('400 9px "Volt Sans"');
  });
});
