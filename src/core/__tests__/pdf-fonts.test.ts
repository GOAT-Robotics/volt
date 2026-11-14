import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";
import { importQet } from "../qet";
import { exportPdf } from "../render/pdf";
import { faceFor } from "../render/pdf-fonts";
import { FIX, readFixtureQet } from "./helpers";

/** BaseFont names of every font resource in the PDF. */
async function fontNames(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Font")) {
      const b = obj.get(PDFName.of("BaseFont"));
      if (b instanceof PDFName) names.add(b.decodeText());
    }
  }
  return names;
}

describe("PDF fonts", () => {
  const file = readdirSync(path.join(FIX, "projects")).find((f) => f.endsWith(".qet"))!;
  const doc = importQet(readFixtureQet(file), file).doc;
  const pages = [...doc.pages].sort((a, b) => a.order - b.order);

  it("maps style fonts to the same bundled faces the canvas uses", () => {
    expect(faceFor("ISOCPEUR,Arial").file).toBe("osifont.ttf");
    expect(faceFor("Arial", 700).file).toBe("LiberationSans-Bold.ttf");
    expect(faceFor("Times New Roman", 400, true).file).toBe("LiberationSerif-Italic.ttf");
    expect(faceFor("Courier New", 400, true)).toMatchObject({ file: "LiberationMono-Regular.ttf", fakeItalic: true });
  });

  it("embeds the bundled fonts instead of standard Helvetica", async () => {
    const bytes = await exportPdf(doc, { pages, paper: "A3" });
    if (process.env.VOLT_PDF_SAMPLE) writeFileSync(process.env.VOLT_PDF_SAMPLE, bytes);
    const names = [...(await fontNames(bytes))];
    expect(names.some((n) => n.startsWith("VOLTAA+Volt"))).toBe(true);
    expect(names.filter((n) => /Helvetica/.test(n))).toEqual([]);
  });
});
