/**
 * Pin classes: what a component terminal carries (AC phase, neutral, PE, DC +/0 V/−, signal).
 * Set per pin in the element editor, or inferred from unambiguous pin names. Used by the ERC to
 * flag pins of different classes on one conductor (L on N, +V on 0 V, power on a data pin) and by
 * automatic wire numbering to pick the circuit class.
 */
import type { PinClass, PinDef } from "./model";
import type { Potential } from "./erc";

type PinLike = Pick<PinDef, "name" | "number"> & Partial<Pick<PinDef, "cls" | "volts">>;

/** class implied by a pin name alone (only names that cannot mean anything else) */
export function inferPinClass(raw: string | undefined): PinClass | null {
  const t = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return null;
  if (/^(PE|⏚|FG|GND\/PE|PE\d?|AC\/FG)$/.test(t)) return "PE";
  if (/^(N|AC\/N|ACN)$/.test(t)) return "N";
  if (/^(L1|L2|L3)$/.test(t)) return t as PinClass;
  if (/^(L|AC\/L|ACL)$/.test(t)) return "L";
  if (/^(\+|\+\d+(\.\d+)?V?|\d+(\.\d+)?V\+?|L\+|V\+|\+V|\+VO|OUT\+|\+OUT|VCC|VIN\+?)$/.test(t)) return "DC+";
  if (/^(-|0V|M|L-|V-|-V|-VO|OUT-|-OUT|GND|VIN-)$/.test(t)) return "DC0";
  if (/^(CAN[_-]?[HL]|CANH|CANL|TXD?|RXD?|SDA|SCL|D\+|D-|RS-?485[_-]?[AB]?|RS-?232|ENC[_-]?[AB]?[+-]?|SIG|DATA)$/.test(t)) return "signal";
  return null;
}

/** volts written in a pin name: "+24V" → 24, "-15V" → -15 */
function voltsOfName(raw: string | undefined): number | undefined {
  const m = /([+-]?)(\d+(?:[.,]\d+)?)\s*V/i.exec(raw ?? "");
  return m ? Number(m[2].replace(",", ".")) * (m[1] === "-" ? -1 : 1) : undefined;
}

/** the effective class of a pin: explicit, else inferred from name / number (null = none / unknown) */
export function pinClassOf(p: PinLike): PinClass | null {
  if (p.cls) return p.cls === "none" ? null : p.cls;
  return inferPinClass(p.name) ?? inferPinClass(p.number);
}

/** is the class set by hand (true) or inferred from the name (false) */
export const pinClassIsExplicit = (p: PinLike) => !!p.cls;

/** the electrical potential a pin carries (signal / none → null) */
export function pinPotential(p: PinLike): Potential | null {
  const c = pinClassOf(p);
  if (!c || c === "signal" || c === "none") return null;
  const text = (p.name || p.number || c).trim();
  const volts = p.volts ?? (c === "DC+" || c === "DC-" ? voltsOfName(p.name) : undefined);
  return { kind: c, volts, text };
}

const POWER: PinClass[] = ["L", "L1", "L2", "L3", "N", "DC+", "DC-"];

/** why a signal pin must not meet this class (null = fine) */
export function signalConflict(a: PinClass, b: PinClass): string | null {
  if (a === "signal" && POWER.includes(b)) return `a signal pin is connected to a ${b === "DC+" ? "DC +" : b} supply pin`;
  if (b === "signal" && POWER.includes(a)) return `a signal pin is connected to a ${a === "DC+" ? "DC +" : a} supply pin`;
  return null;
}
