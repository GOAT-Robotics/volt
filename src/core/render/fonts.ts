/**
 * Font readiness for screen text. Text widths depend on which font the browser actually has, and a
 * web font (the bundled ISO 3098 drawing font) arrives a moment after the first paint. Every cache
 * of measured text (word positions, label boxes, cross-references, the hit-test index) includes
 * `fontEpoch()` in its key, so a finished font load lays text out again instead of keeping widths
 * measured in the fallback font.
 */
let epoch = 0;
export const fontEpoch = () => epoch;
export function bumpFontEpoch() {
  epoch++;
}
