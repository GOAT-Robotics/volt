/**
 * Brother P-touch raster command encoder (PT-E550W, PT-E560BT, PT-P750W, PT-P710BT, PT-P700,
 * PT-D600, PT-H500 … — 180 dpi, 128-pin heads), after Brother's "Raster Command Reference" for
 * these models. Produces the byte stream for one print job of one or more labels; the transport
 * (WebUSB, Web Serial over Bluetooth, or a raw TCP/printer queue) only sends the bytes.
 *
 * A label is a 1-bit bitmap: `length` dots along the tape × `pins` dots across it. Each raster
 * line is one column across the tape (16 bytes for 128 pins), compressed with TIFF PackBits.
 */

export const PT_DPI = 180;
export const mmToDots = (mm: number) => Math.round((mm * PT_DPI) / 25.4);

/** printable pins and left margin (pins) on the 128-pin head, per tape width (mm) */
const TZE: Record<number, { pins: number; left: number }> = { 3.5: { pins: 24, left: 52 }, 6: { pins: 32, left: 48 }, 9: { pins: 50, left: 39 }, 12: { pins: 70, left: 29 }, 18: { pins: 112, left: 8 }, 24: { pins: 128, left: 0 } };
const HSE: Record<number, { pins: number; left: number }> = { 6: { pins: 28, left: 50 }, 9: { pins: 48, left: 40 }, 12: { pins: 66, left: 31 }, 18: { pins: 106, left: 11 }, 24: { pins: 128, left: 0 } };

export function headArea(widthMm: number, heatShrink: boolean): { pins: number; left: number } {
  const t = heatShrink ? HSE : TZE;
  return t[widthMm] ?? t[Object.keys(t).map(Number).reduce((a, b) => (Math.abs(b - widthMm) < Math.abs(a - widthMm) ? b : a))];
}

/** 1-bit label image: bits[x * pins + y] = 1 → black; x along the tape, y across (0 = top edge) */
export type PtBitmap = { length: number; pins: number; bits: Uint8Array };

export type PtJob = {
  labels: PtBitmap[];
  /** media type: 0x01 laminated TZe, 0x03 non-laminated, 0x11 heat-shrink tube (2:1), 0x17 heat-shrink 3:1 */
  mediaType: number;
  /** nominal tape width (mm) */
  widthMm: number;
  /** cut after every label (true) or only at the end of the job */
  autoCut: boolean;
  /** half cut between labels (keeps the backing; PT-E550W / P750W / P900 series) */
  halfCut: boolean;
  /** feed margin at both ends of each label, dots (14 dots ≈ 2 mm) */
  feedDots: number;
  /** mirror across the tape (calibration for printers that print upside down) */
  flip?: boolean;
  /** extra offset across the tape in pins (calibration) */
  offsetPins?: number;
  compress?: boolean;
};

/** TIFF PackBits */
export function packBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    // run of identical bytes
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 2) {
      out.push(257 - run, src[i]);
      i += run;
      continue;
    }
    // literal run until the next repeat of 2+
    const start = i;
    let lit = 0;
    while (i < src.length && lit < 128 && !(i + 1 < src.length && src[i] === src[i + 1])) {
      i++;
      lit++;
    }
    out.push(lit - 1);
    for (let k = start; k < start + lit; k++) out.push(src[k]);
  }
  return Uint8Array.from(out);
}

export function unpackBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const n = src[i++] > 127 ? src[i - 1] - 256 : src[i - 1];
    if (n >= 0) for (let k = 0; k <= n; k++) out.push(src[i++]);
    else if (n !== -128) {
      const v = src[i++];
      for (let k = 0; k < 1 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

const ESC = 0x1b;

/** the complete byte stream of a print job */
export function encodeJob(job: PtJob): Uint8Array {
  const parts: number[] = [];
  const push = (...b: number[]) => {
    for (const x of b) parts.push(x & 0xff);
  };
  // invalidate (clears a half-received previous job), initialise, raster mode
  for (let i = 0; i < 100; i++) parts.push(0);
  push(ESC, 0x40);
  push(ESC, 0x69, 0x61, 0x01);
  const heat = job.mediaType === 0x11 || job.mediaType === 0x17;
  const area = headArea(job.widthMm, heat);
  job.labels.forEach((lab, page) => {
    const last = page === job.labels.length - 1;
    // print information: valid flags = media type | width | recovery
    const n = lab.length;
    push(ESC, 0x69, 0x7a, 0x86, job.mediaType, Math.round(job.widthMm), 0, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, page === 0 ? 0 : 1, 0);
    // various mode: auto cut
    push(ESC, 0x69, 0x4d, job.autoCut ? 0x40 : 0x00);
    // cut every label
    if (job.autoCut) push(ESC, 0x69, 0x41, 0x01);
    // advanced mode: half cut, no chain printing (feed and cut after the last label)
    push(ESC, 0x69, 0x4b, (job.halfCut ? 0x04 : 0) | (last ? 0x08 : 0));
    // margin (feed amount)
    push(ESC, 0x69, 0x64, job.feedDots & 0xff, (job.feedDots >> 8) & 0xff);
    // compression mode: TIFF
    push(0x4d, job.compress === false ? 0x00 : 0x02);
    const line = new Uint8Array(16);
    for (let x = 0; x < lab.length; x++) {
      line.fill(0);
      let any = false;
      for (let y = 0; y < lab.pins; y++) {
        if (!lab.bits[x * lab.pins + y]) continue;
        const yy = job.flip ? lab.pins - 1 - y : y;
        const pin = area.left + (job.offsetPins ?? 0) + yy;
        if (pin < 0 || pin > 127) continue;
        // pin 0 is the most significant bit of the first byte
        line[pin >> 3] |= 0x80 >> (pin & 7);
        any = true;
      }
      if (!any && job.compress !== false) {
        push(0x5a); // zero raster line
        continue;
      }
      const data = job.compress === false ? line : packBits(line);
      push(0x47, data.length & 0xff, (data.length >> 8) & 0xff, ...data);
    }
    push(last ? 0x1a : 0x0c);
  });
  return Uint8Array.from(parts);
}

/** status request (the printer answers with 32 bytes) */
export const STATUS_REQUEST = Uint8Array.from([...new Array(100).fill(0), ESC, 0x40, ESC, 0x69, 0x53]);

export type PtStatus = { model: number; mediaWidth: number; mediaType: number; errors: string[]; raw: Uint8Array };

const ERR1: [number, string][] = [
  [0x01, "No media"],
  [0x04, "Cutter jam"],
  [0x08, "Weak batteries"],
  [0x40, "High-voltage adapter"],
];
const ERR2: [number, string][] = [
  [0x01, "Wrong media"],
  [0x10, "Cover open"],
  [0x20, "Overheating"],
];
export const MEDIA_TYPE_NAME: Record<number, string> = { 0x00: "no media", 0x01: "laminated tape", 0x03: "non-laminated tape", 0x04: "fabric tape", 0x11: "heat-shrink tube (2:1)", 0x13: "flexible tape", 0x14: "fluorescent tape", 0x17: "heat-shrink tube (3:1)", 0xff: "incompatible tape" };

export function parseStatus(b: Uint8Array): PtStatus | null {
  if (b.length < 32 || b[0] !== 0x80) return null;
  const errors = [...ERR1.filter(([m]) => b[8] & m).map(([, t]) => t), ...ERR2.filter(([m]) => b[9] & m).map(([, t]) => t)];
  return { model: b[4], mediaWidth: b[10], mediaType: b[11], errors, raw: b };
}
