import { describe, expect, it } from "vitest";
import type { PartialStyles } from "../model";
import { TEXT_ROLES } from "../model";
import { cssFont, deepMerge, defaultStyles, effectiveText, isRole, projectStyles, qetColor } from "../styles";
import { docStyles, layoutElementTexts } from "../render/scene";
import { symbolFor } from "../render/symbol";
import { approxMeasure } from "../render/svg";
import { newElement } from "../ops";
import { mkDoc, twoPin } from "./helpers";

describe("deepMerge", () => {
  it("merges nested objects without mutating inputs", () => {
    const base = { a: 1, b: { c: 2, d: { e: 3, f: 4 } }, arr: [1, 2] };
    const snap = structuredClone(base);
    const out = deepMerge(base, { b: { d: { e: 30 } }, arr: [9] });
    expect(out).toEqual({ a: 1, b: { c: 2, d: { e: 30, f: 4 } }, arr: [9] });
    expect(base).toEqual(snap);
    expect(out.b).not.toBe(base.b);
  });
  it("skips undefined, keeps null overrides, tolerates missing override", () => {
    const base = { a: 1, bg: "#fff" as string | null };
    expect(deepMerge(base, { a: undefined })).toEqual(base);
    expect(deepMerge(base, { bg: null })).toEqual({ a: 1, bg: null });
    expect(deepMerge(base, undefined)).toBe(base);
    expect(deepMerge(base, null)).toBe(base);
  });
});

describe("style precedence: org base → project → element → object override", () => {
  const org = defaultStyles();
  org.text.componentRef.size = 11;
  org.text.componentRef.color = "#000001";
  org.text.componentRef.font = "OrgFont";
  const project: PartialStyles = { text: { componentRef: { size: 12, color: "#000002" } }, graphics: { wire: { color: "#00ff00" } } };

  it("projectStyles overlays the project partial on the org base", () => {
    const s = projectStyles(org, project);
    expect(s.text.componentRef).toMatchObject({ size: 12, color: "#000002", font: "OrgFont", weight: 600 });
    expect(s.graphics.wire).toMatchObject({ color: "#00ff00", width: 1, junctionRadius: 2.5 });
    expect(s.text.pinNumber).toEqual(org.text.pinNumber);
    expect(org.text.componentRef.size).toBe(11); // base untouched
  });

  it("effectiveText applies element then object overrides, later wins, undefined ignored", () => {
    const s = projectStyles(org, project);
    const elementDefault = { size: 13, italic: true };
    const objectOverride = { size: 14, color: undefined, align: "right" as const };
    const t = effectiveText(s, "componentRef", elementDefault, objectOverride);
    expect(t).toMatchObject({ size: 14, italic: true, color: "#000002", font: "OrgFont", align: "right" });
    expect(effectiveText(s, "componentRef")).toEqual(s.text.componentRef);
    expect(effectiveText(s, "componentRef", undefined, { visible: false }).visible).toBe(false);
  });

  it("falls back to the annotation style for unknown roles", () => {
    const s = defaultStyles();
    expect(effectiveText(s, "bogus" as never)).toEqual(s.text.annotation);
  });

  it("docStyles applies the chain used by rendering and follows project edits", () => {
    const { doc, page } = mkDoc();
    doc.baseStyles = org;
    doc.styles = project;
    expect(docStyles(doc).text.componentRef.size).toBe(12);
    doc.styles = { text: { componentRef: { size: 20 } } };
    expect(docStyles(doc).text.componentRef.size).toBe(20);
    // object override reaches the laid-out text
    const def = twoPin("relay");
    const e = newElement(doc, page, def, { x: 105, y: 105 });
    e.info.label = "K1";
    const lbl = e.texts.find((t) => t.info === "label")!;
    lbl.override = { size: 30 };
    const laid = layoutElementTexts(e, symbolFor(def), docStyles(doc), approxMeasure);
    expect(laid.find((t) => t.text === "K1")!.style.size).toBe(30);
  });
});

describe("misc style helpers", () => {
  it("defaultStyles defines every role", () => {
    const s = defaultStyles();
    for (const r of TEXT_ROLES) expect(s.text[r]).toBeDefined();
    expect(isRole("wireLabel")).toBe(true);
    expect(isRole("nope")).toBe(false);
  });
  it("cssFont / qetColor", () => {
    expect(cssFont({ ...defaultStyles().text.componentRef, italic: true }, 2)).toBe("italic 600 20px Inter, Helvetica, Arial, sans-serif");
    expect(qetColor("red")).toBe("#e11d48");
    expect(qetColor("#123456")).toBe("#123456");
    expect(qetColor("bogus", "#fff")).toBe("#fff");
    expect(qetColor(undefined)).toBe("#000000");
  });
});
