import { describe, expect, it } from "vitest";
import { layoutRich, parseInline, parseRich, plainText } from "../richtext";
import { defaultStyles } from "../styles";
import { approxMeasure } from "../render/svg";

const st = { ...defaultStyles().text.annotation, size: 9, lineHeight: 1.2 };

describe("formatted text", () => {
  it("parses lists, headings, rules and inline styles", () => {
    const p = parseRich("# Title\n- one\n  - nested **bold**\n1. first\n---\nplain *it* 2*3");
    expect(p.map((x) => [x.kind, x.marker, x.level])).toEqual([["h1", null, 0], ["p", "•", 0], ["p", "•", 1], ["p", "1.", 0], ["rule", null, 0], ["p", null, 0]]);
    expect(p[2].runs).toEqual([{ text: "nested ", bold: false, italic: false }, { text: "bold", bold: true, italic: false }]);
    expect(parseInline("plain *it* 2*3").map((r) => [r.text, r.italic])).toEqual([["plain ", false], ["it", true], [" 2*3", false]]);
    expect(plainText("- a\n  1. b\n**c**")).toBe("• a\n  1. b\nc");
  });

  it("wraps at the box width and aligns", () => {
    const text = "The quick brown fox jumps over the lazy dog and keeps running far away";
    const l = layoutRich(text, st, { width: 120, padding: 4 }, approxMeasure);
    const ys = [...new Set(l.items.map((i) => i.y))];
    expect(ys.length).toBeGreaterThan(2);
    expect(l.w).toBe(120);
    for (const i of l.items) expect(i.x + approxMeasure(i.text, i.size) ).toBeLessThanOrEqual(116.5);
    const r = layoutRich("short", st, { width: 120, align: "right" }, approxMeasure);
    expect(r.items[0].x + approxMeasure("short", r.items[0].size)).toBeCloseTo(116, 0);
    const j = layoutRich(text, st, { width: 120, align: "justify" }, approxMeasure);
    const first = j.items.filter((i) => i.y === j.items[0].y);
    const last = first[first.length - 1];
    expect(last.x + approxMeasure(last.text, last.size)).toBeCloseTo(116, 0);
  });

  it("indents list items and spaces paragraphs", () => {
    const a = layoutRich("- a\n- b", st, {}, approxMeasure);
    const b = layoutRich("- a\n- b", st, { paraGap: 6 }, approxMeasure);
    expect(b.h - a.h).toBeCloseTo(6 * (4 / 3), 3);
    const bullet = a.items.find((i) => i.text === "•")!;
    const word = a.items.find((i) => i.text === "a")!;
    expect(word.x).toBeGreaterThan(bullet.x);
  });
});
