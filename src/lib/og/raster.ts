import "server-only";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

/**
 * SVG → PNG on the server (link preview images). Fonts ship with the app (public/fonts, SIL OFL),
 * so pictures look the same on every host: Liberation Sans stands in for Arial / Helvetica / Inter
 * in drawings (same metrics as Arial), Work Sans sets the card headings.
 */
const FONT_DIR = path.join(process.cwd(), "public", "fonts");
const FONTS = ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf", "WorkSans-Regular.ttf", "WorkSans-Bold.ttf"].map((f) => path.join(FONT_DIR, f));

export function svgToPng(svg: string, width: number): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      loadSystemFonts: false,
      fontFiles: FONTS,
      defaultFontFamily: "Liberation Sans",
      sansSerifFamily: "Liberation Sans",
      serifFamily: "Liberation Sans",
      monospaceFamily: "Liberation Sans",
    },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0,
  });
  return r.render().asPng();
}
