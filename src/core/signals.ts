/**
 * Signal / data buses: what a signal pin is (CAN H, RS-485 A, UART TX …) and which pins may be
 * wired together. Same-name buses (CAN, RS-485, I²C, SPI, USB, LIN, encoder) connect line to
 * line; point-to-point serial (UART, RS-232) crosses TX → RX and RTS → CTS; digital outputs drive
 * inputs. This is the pin-to-pin map a harness is built from.
 */
export type BusId = "CAN" | "RS485" | "RS232" | "UART" | "ETH" | "I2C" | "SPI" | "USB" | "LIN" | "ENC" | "DIO" | "AIO";
export type SigRef = { bus: BusId; line: string };

type Bus = {
  id: BusId;
  name: string;
  lines: string[];
  /** a line may connect to these lines of another device (default: the same line; common lines always to themselves) */
  mate?: Record<string, string[]>;
  /** lines shared by everything on the bus (reference, shield) */
  common?: string[];
  /** name regex (whole pin name) → line, to recognise pins by name */
  names: [RegExp, string][];
};

export const BUSES: Bus[] = [
  { id: "CAN", name: "CAN", lines: ["H", "L", "GND", "SHLD"], common: ["GND", "SHLD"], names: [[/^CAN[_\s-]?H(I(GH)?)?$/i, "H"], [/^CAN[_\s-]?L(O(W)?)?$/i, "L"], [/^CAN[_\s-]?(GND|0V|COM)$/i, "GND"], [/^CAN[_\s-]?(SHLD|SHIELD)$/i, "SHLD"]] },
  { id: "RS485", name: "RS-485", lines: ["A", "B", "GND", "SHLD"], common: ["GND", "SHLD"], names: [[/^(RS-?485[_\s-]?A|485[_\s-]?A|D-|DATA-|TRX-)$/i, "A"], [/^(RS-?485[_\s-]?B|485[_\s-]?B|D\+|DATA\+|TRX\+)$/i, "B"], [/^(RS-?485[_\s-]?(GND|COM)|485[_\s-]?GND)$/i, "GND"]] },
  { id: "RS232", name: "RS-232", lines: ["TXD", "RXD", "RTS", "CTS", "DTR", "DSR", "GND"], common: ["GND"], mate: { TXD: ["RXD"], RXD: ["TXD"], RTS: ["CTS"], CTS: ["RTS"], DTR: ["DSR"], DSR: ["DTR"] }, names: [[/^(RS-?232[_\s-]?)?TXD$/i, "TXD"], [/^(RS-?232[_\s-]?)?RXD$/i, "RXD"], [/^RTS$/i, "RTS"], [/^CTS$/i, "CTS"], [/^DTR$/i, "DTR"], [/^DSR$/i, "DSR"]] },
  { id: "UART", name: "UART (TTL)", lines: ["TX", "RX", "GND"], common: ["GND"], mate: { TX: ["RX"], RX: ["TX"] }, names: [[/^(UART\d?[_\s-]?)?TX\d?$/i, "TX"], [/^(UART\d?[_\s-]?)?RX\d?$/i, "RX"]] },
  { id: "ETH", name: "Ethernet", lines: ["TX+", "TX-", "RX+", "RX-", "SHLD"], common: ["SHLD"], mate: { "TX+": ["RX+", "TX+"], "TX-": ["RX-", "TX-"], "RX+": ["TX+", "RX+"], "RX-": ["TX-", "RX-"] }, names: [[/^((ETH[_\s-]?)?TX\+|TD\+)$/i, "TX+"], [/^((ETH[_\s-]?)?TX-|TD-)$/i, "TX-"], [/^((ETH[_\s-]?)?RX\+|RD\+)$/i, "RX+"], [/^((ETH[_\s-]?)?RX-|RD-)$/i, "RX-"]] },
  { id: "I2C", name: "I²C", lines: ["SDA", "SCL", "GND"], common: ["GND"], names: [[/^(I2C[_\s-]?)?SDA$/i, "SDA"], [/^(I2C[_\s-]?)?SCL$/i, "SCL"]] },
  { id: "SPI", name: "SPI", lines: ["SCK", "MOSI", "MISO", "CS", "GND"], common: ["GND"], names: [[/^(SPI[_\s-]?)?(SCK|SCLK|CLK)$/i, "SCK"], [/^(SPI[_\s-]?)?(MOSI|SDO|COPI)$/i, "MOSI"], [/^(SPI[_\s-]?)?(MISO|SDI|CIPO)$/i, "MISO"], [/^(SPI[_\s-]?)?(CS|SS|NSS)$/i, "CS"]] },
  { id: "USB", name: "USB", lines: ["VBUS", "D+", "D-", "GND", "SHLD"], common: ["GND", "SHLD", "VBUS"], names: [[/^(USB[_\s-]?)?VBUS$/i, "VBUS"], [/^USB[_\s-]?(D\+|DP)$/i, "D+"], [/^USB[_\s-]?(D-|DM)$/i, "D-"]] },
  { id: "LIN", name: "LIN", lines: ["LIN", "GND"], common: ["GND"], names: [[/^LIN$/i, "LIN"]] },
  { id: "ENC", name: "Encoder", lines: ["A+", "A-", "B+", "B-", "Z+", "Z-", "V+", "GND", "SHLD"], common: ["GND", "SHLD", "V+"], names: [[/^(ENC[_\s-]?A\+?|A\+)$/i, "A+"], [/^(ENC[_\s-]?A-|A-|\/A)$/i, "A-"], [/^(ENC[_\s-]?B\+?|B\+)$/i, "B+"], [/^(ENC[_\s-]?B-|B-|\/B)$/i, "B-"], [/^(ENC[_\s-]?Z\+?|Z\+)$/i, "Z+"], [/^(ENC[_\s-]?Z-|Z-|\/Z)$/i, "Z-"]] },
  { id: "DIO", name: "Digital I/O", lines: ["OUT", "IN"], mate: { OUT: ["IN"], IN: ["OUT", "IN"] }, names: [[/^((DO|DQ|Q)\d+(\.\d+)?|OUT\d+)$/i, "OUT"], [/^(DI|IN|I)\d+(\.\d+)?$/i, "IN"]] },
  { id: "AIO", name: "Analog I/O", lines: ["OUT", "IN", "COM"], common: ["COM"], mate: { OUT: ["IN"], IN: ["OUT", "IN"] }, names: [[/^(AO|AQ)\d*$/i, "OUT"], [/^AI\d*[+]?$/i, "IN"]] },
];
export const busById = (id: string | undefined) => BUSES.find((b) => b.id === id);

/** bus + line implied by a pin name ("CAN_H" → CAN H, "TXD" → RS-232 TXD, "TX" → UART TX), or null */
export function inferSig(name: string | undefined): SigRef | null {
  const t = (name ?? "").trim();
  if (!t) return null;
  for (const b of BUSES) for (const [re, line] of b.names) if (re.test(t)) return { bus: b.id, line };
  return null;
}

/** why two signal pins must not share a conductor (null = they may) */
export function sigConflict(a: SigRef, b: SigRef): string | null {
  if (a.bus !== b.bus) {
    // a bare digital line may meet any single-ended line of the same kind only — different buses never
    return `${busById(a.bus)?.name ?? a.bus} ${a.line} is wired to ${busById(b.bus)?.name ?? b.bus} ${b.line}`;
  }
  const bus = busById(a.bus);
  if (!bus) return null;
  if (bus.common?.includes(a.line) || bus.common?.includes(b.line)) return a.line === b.line ? null : `${bus.name} ${a.line} is wired to ${b.line}`;
  const ok = (x: string, y: string) => (bus.mate?.[x] ?? [x]).includes(y);
  if (ok(a.line, b.line) || ok(b.line, a.line)) return null;
  const want = bus.mate?.[a.line]?.join(" / ") ?? a.line;
  return `${bus.name} ${a.line} is wired to ${b.line} (expected ${want})`;
}

export const sigText = (s: SigRef) => `${busById(s.bus)?.name ?? s.bus} ${s.line}`;
