/**
 * Fonts for the PDF export. The canvas never draws with a font from the viewer's computer — every
 * style maps to one of the bundled families (drawing-fonts.ts) — so the PDF must embed those same
 * files. With pdf-lib's built-in Helvetica the PDF measured and drew text in a different font from
 * the one the drawing was laid out in, and labels overlapped symbols, wires and each other.
 *
 * Only the faces a PDF actually uses are embedded, as subsets. Names are fixed (no random subset
 * tag) so `deterministic` exports stay byte-for-byte reproducible for signing.
 */
import type { PDFDocument, PDFFont } from "pdf-lib";
import { StandardFonts } from "pdf-lib";
import { BUNDLED_FONTS, bundledFamily, type BundledFont } from "./drawing-fonts";

/** Reads one file from public/fonts. */
export type FontLoader = (file: string) => Promise<Uint8Array>;

type Style = "regular" | "bold" | "italic" | "boldItalic";
type FaceFile = { file: string; name: string; fakeBold?: boolean; fakeItalic?: boolean };

/** File behind every face; faces a family lacks fall back the way the browser synthesizes them. */
const FACES: Record<BundledFont, Record<Style, FaceFile>> = {
  "Volt ISO": {
    regular: { file: "osifont.ttf", name: "VoltISO" },
    bold: { file: "osifont.ttf", name: "VoltISO", fakeBold: true },
    italic: { file: "osifont-italic.ttf", name: "VoltISO-Italic" },
    boldItalic: { file: "osifont-italic.ttf", name: "VoltISO-Italic", fakeBold: true },
  },
  "Volt Sans": {
    regular: { file: "LiberationSans-Regular.ttf", name: "VoltSans" },
    bold: { file: "LiberationSans-Bold.ttf", name: "VoltSans-Bold" },
    italic: { file: "LiberationSans-Italic.ttf", name: "VoltSans-Italic" },
    boldItalic: { file: "LiberationSans-BoldItalic.ttf", name: "VoltSans-BoldItalic" },
  },
  "Volt Serif": {
    regular: { file: "LiberationSerif-Regular.ttf", name: "VoltSerif" },
    bold: { file: "LiberationSerif-Bold.ttf", name: "VoltSerif-Bold" },
    italic: { file: "LiberationSerif-Italic.ttf", name: "VoltSerif-Italic" },
    boldItalic: { file: "LiberationSerif-BoldItalic.ttf", name: "VoltSerif-BoldItalic" },
  },
  "Volt Mono": {
    regular: { file: "LiberationMono-Regular.ttf", name: "VoltMono" },
    bold: { file: "LiberationMono-Bold.ttf", name: "VoltMono-Bold" },
    italic: { file: "LiberationMono-Regular.ttf", name: "VoltMono", fakeItalic: true },
    boldItalic: { file: "LiberationMono-Bold.ttf", name: "VoltMono-Bold", fakeItalic: true },
  },
};

const styleOf = (weight: number | undefined, italic: boolean | undefined): Style =>
  (weight ?? 400) >= 600 ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular";

export function faceFor(font: string, weight?: number, italic?: boolean): FaceFile {
  return FACES[bundledFamily(font)][styleOf(weight, italic)];
}

const cache = new Map<string, Promise<Uint8Array>>();

async function readFont(file: string): Promise<Uint8Array> {
  if (typeof window !== "undefined") {
    const res = await fetch(`/fonts/${file}`);
    if (!res.ok) throw new Error(`font ${file}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  // Server (route handlers, MCP, tests): public/ sits beside the server in dev and in the standalone image.
  // getBuiltinModule keeps node:fs out of the browser bundle.
  const proc = (globalThis as { process?: { cwd(): string; getBuiltinModule?(id: string): unknown } }).process;
  const fs = proc?.getBuiltinModule?.("node:fs/promises") as typeof import("node:fs/promises") | undefined;
  const path = proc?.getBuiltinModule?.("node:path") as typeof import("node:path") | undefined;
  if (!proc || !fs || !path) throw new Error("no way to read bundled fonts here");
  return new Uint8Array(await fs.readFile(path.join(proc.cwd(), "public", "fonts", file)));
}

/** Default loader: browser fetches /fonts/…, server reads public/fonts; results are cached per file. */
export const loadBundledFont: FontLoader = (file) => {
  let p = cache.get(file);
  if (!p) {
    p = readFont(file);
    cache.set(file, p);
    p.catch(() => cache.delete(file));
  }
  return p;
};

export type PdfFace = { font: PDFFont; fakeBold: boolean; fakeItalic: boolean };

/** The faces embedded in one PDF document. */
export class PdfFontSet {
  private embedded = new Map<string, Promise<PDFFont>>();
  private ready = new Map<string, PDFFont>();
  private fallback: { regular: PDFFont; bold: PDFFont; italic: PDFFont } | null = null;
  private fontkitReady: Promise<void> | null = null;

  constructor(
    private pdf: PDFDocument,
    private loader: FontLoader = loadBundledFont,
  ) {}

  private async registerFontkit() {
    // loaded on demand so fontkit stays out of the editor's first bundle
    this.fontkitReady ??= import("@pdf-lib/fontkit").then((m) => {
      const fk = ((m as { default?: unknown }).default ?? m) as Parameters<PDFDocument["registerFontkit"]>[0];
      this.pdf.registerFontkit(fk);
    });
    return this.fontkitReady;
  }

  private async embedFile(f: FaceFile): Promise<PDFFont> {
    let p = this.embedded.get(f.name);
    if (!p) {
      p = (async () => {
        await this.registerFontkit();
        const bytes = await this.loader(f.file);
        // a fixed subset tag keeps deterministic exports reproducible
        const font = await this.pdf.embedFont(bytes, { subset: true, customName: `VOLTAA+${f.name}` });
        this.ready.set(f.name, font);
        return font;
      })();
      this.embedded.set(f.name, p);
    }
    return p;
  }

  /** Embeds the faces for these (font, weight, italic) uses; falls back to Helvetica if the files cannot be read. */
  async prepare(uses: Iterable<{ font: string; weight?: number; italic?: boolean }>) {
    const files = new Map<string, FaceFile>();
    for (const u of uses) {
      const f = faceFor(u.font, u.weight, u.italic);
      files.set(f.name, f);
    }
    try {
      await Promise.all([...files.values()].map((f) => this.embedFile(f)));
    } catch (e) {
      console.warn("[pdf] bundled fonts unavailable, falling back to Helvetica:", e);
      await this.useFallback();
    }
  }

  private async useFallback() {
    if (this.fallback) return;
    this.fallback = {
      regular: await this.pdf.embedFont(StandardFonts.Helvetica),
      bold: await this.pdf.embedFont(StandardFonts.HelveticaBold),
      italic: await this.pdf.embedFont(StandardFonts.HelveticaOblique),
    };
  }

  /** Face for a text draw; prepare() must have covered it. */
  face(font: string, weight?: number, italic?: boolean): PdfFace {
    const f = faceFor(font, weight, italic);
    const hit = this.ready.get(f.name);
    if (hit && !this.fallback) return { font: hit, fakeBold: !!f.fakeBold, fakeItalic: !!f.fakeItalic };
    const fb = this.fallback;
    if (fb) {
      const s = styleOf(weight, italic);
      return { font: s === "bold" || s === "boldItalic" ? fb.bold : s === "italic" ? fb.italic : fb.regular, fakeBold: false, fakeItalic: false };
    }
    // not prepared: any embedded face is better than throwing mid-export
    const any = this.ready.values().next().value;
    if (!any) throw new Error(`PDF font not prepared: ${f.name}`);
    return { font: any, fakeBold: false, fakeItalic: false };
  }

  /** Volt Sans regular / bold / italic, for appended table pages (BOM, terminal plan, comments). */
  async sans() {
    const s = BUNDLED_FONTS.sans;
    await this.prepare([{ font: s }, { font: s, weight: 700 }, { font: s, italic: true }]);
    return { regular: this.face(s).font, bold: this.face(s, 700).font, italic: this.face(s, 400, true).font };
  }
}

/** Volt Sans for standalone table PDFs (BOM / terminal plan downloads). */
export async function embedSans(pdf: PDFDocument, loader?: FontLoader) {
  return new PdfFontSet(pdf, loader).sans();
}
