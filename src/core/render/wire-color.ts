/**
 * The colour a conductor is drawn in, shared by the schematic and the terminal diagram sheet so a
 * wire looks the same on both: an explicit colour (on the wire or its cable core) always; the
 * standard colour of its function, or else of its detected circuit, only with "draw in standard
 * colors" on. Two-colour insulation (green-yellow …) gives a second colour, drawn as stripes.
 */
import type { Doc, Wire } from "../model";
import { circuitOf } from "../circuit";
import { colorOf, wireInfo } from "../wiring";

export type WireLookDoc = Pick<Doc, "wiring" | "cables">;

/** null = no colour of its own: drawn in the wire style's colour */
export function insulationHex(doc: WireLookDoc, w: Wire): { hex: string; hex2?: string } | null {
  if (!w.insulation && !w.core && !doc.wiring?.colorize) return null;
  const i = wireInfo(doc, w);
  if (i.look && (i.colorSource !== "standard" || doc.wiring?.colorize)) return { hex: i.look.hex, hex2: i.look.hex2 };
  // "draw in standard colors": a wire without its own potential / use takes the detected circuit's colour
  if (doc.wiring?.colorize && "pages" in doc) {
    const c = colorOf(circuitOf(doc as Doc, w.id)?.color);
    if (c) return { hex: c.hex, hex2: c.hex2 };
  }
  return null;
}
