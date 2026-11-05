/**
 * Drawings never use fonts installed on the viewer's computer: the same project must measure and
 * draw identically on every machine (Mac without ISOCPEUR, Windows with it, Linux with neither).
 * Every font name a style can hold maps to one of four families the app serves itself
 * (src/app/globals.css, files in public/fonts):
 *
 *   Volt ISO    ISOCPEUR / ISO 3098 drafting fonts      osifont (GPL-3 + font exception)
 *   Volt Sans   Arial, Helvetica, Inter, … and unknown  Liberation Sans (Arial metrics, OFL)
 *   Volt Serif  Times New Roman, Georgia, serif         Liberation Serif (Times metrics, OFL)
 *   Volt Mono   Courier New, monospace                  Liberation Mono (Courier metrics, OFL)
 *
 * The style keeps the name the user picked (QElectroTech files round-trip unchanged); only what the
 * canvas is told to use is replaced.
 */
export const BUNDLED_FONTS = { iso: "Volt ISO", sans: "Volt Sans", serif: "Volt Serif", mono: "Volt Mono" } as const;
export type BundledFont = (typeof BUNDLED_FONTS)[keyof typeof BUNDLED_FONTS];

const ISO = /isocp|iso ?3098|osifont|volt iso/;
const MONO = /mono|courier|consolas|menlo|monaco|lucida console/;
const SERIF = /times|georgia|garamond|cambria|palatino|book antiqua|baskerville|liberation serif|volt serif/;
const SANS = /sans|arial|helvetica|inter|roboto|segoe|verdana|tahoma|calibri|ui-|system|blinkmac|-apple/;

const cache = new Map<string, BundledFont>();

/** The bundled family that stands in for a CSS font list such as "ISOCPEUR, Arial, sans-serif". */
export function bundledFamily(font: string): BundledFont {
  let hit = cache.get(font);
  if (hit) return hit;
  hit = BUNDLED_FONTS.sans;
  for (const raw of font.split(",")) {
    const n = raw.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
    if (!n) continue;
    if (ISO.test(n)) hit = BUNDLED_FONTS.iso;
    else if (MONO.test(n)) hit = BUNDLED_FONTS.mono;
    else if (n === "serif" || SERIF.test(n)) hit = BUNDLED_FONTS.serif;
    else if (SANS.test(n)) hit = BUNDLED_FONTS.sans;
    else continue; // a font we do not know: look at the next one in the list
    break;
  }
  cache.set(font, hit);
  return hit;
}

/** CSS font value for canvas text, always naming a bundled family. */
export function canvasFont(size: number, font: string, weight = 400, italic = false): string {
  return `${italic ? "italic " : ""}${weight} ${size}px "${bundledFamily(font)}"`;
}

/** Faces worth fetching before the first paint (the rest load when a drawing uses them). */
export const PRELOAD_FONTS = [`400 16px "${BUNDLED_FONTS.iso}"`, `400 16px "${BUNDLED_FONTS.sans}"`, `700 16px "${BUNDLED_FONTS.sans}"`];
