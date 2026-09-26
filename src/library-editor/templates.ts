/** Starting-point generators for the "New element" wizard (no CAD knowledge needed). */
import type { ElementDef, Orient, PinDef, Prim, PrimStyle } from "@/core/model";
import { blankDef, finalizeDef, newUuid } from "@/lib/library/elmt-tools";
import { approxMeasure } from "@/core/render/svg";
import { PT } from "@/core/render/symbol";

export const S = (o: Partial<PrimStyle> = {}): PrimStyle => ({ lineStyle: "normal", lineWeight: "normal", filling: "none", color: "black", ...o });
const line = (x1: number, y1: number, x2: number, y2: number, style = S()): Prim => ({ t: "line", x1, y1, x2, y2, end1: "none", end2: "none", len1: 1.5, len2: 1.5, style });
const rect = (x: number, y: number, w: number, h: number, style = S()): Prim => ({ t: "rect", x, y, w, h, rx: 0, ry: 0, style });
const ellipse = (x: number, y: number, w: number, h: number, style = S()): Prim => ({ t: "ellipse", x, y, w, h, style });
const text = (x: number, y: number, t: string, size = 9): Prim => ({ t: "text", x, y, text: t, size, rotation: 0, color: "#000000" });
export const labelText = (x: number, y: number): Prim => ({ t: "dyntext", x, y, from: "ElementInfo", info: "label", text: "", size: 9, rotation: 0, halign: "left", valign: "top", frame: false, width: -1, uuid: newUuid() });
export const pin = (x: number, y: number, orient: Orient, number: string, name = ""): PinDef => ({ id: newUuid(), x, y, orient, number, name: name || number, type: "Generic" });

export type TemplateId = "box" | "coil" | "contact" | "motor" | "lamp";

export type BoxOpts = { left: number; right: number; pitch: number; width: number; leftLabels: string; rightLabels: string; showNames: boolean; kind: "connector" | "terminal" | "plc" };
export type ContactOpts = { state: "NO" | "NC"; role: "slave" | "switch"; numbers: string };
export type MotorOpts = { phases: 1 | 3; pe: boolean };

export const TEMPLATE_INFO: Record<TemplateId, { title: string; desc: string; prefix: string }> = {
  box: { title: "Box with pins", desc: "Connector, terminal strip, PLC card, module…", prefix: "X" },
  coil: { title: "Relay coil", desc: "Rectangle with A1 / A2 — master of contacts", prefix: "K" },
  contact: { title: "Contact (NO / NC)", desc: "Relay contact or switch", prefix: "" },
  motor: { title: "Motor", desc: "Circle with M, 1- or 3-phase", prefix: "M" },
  lamp: { title: "Indicator lamp", desc: "Circle with cross, X1 / X2", prefix: "H" },
};

function labels(spec: string, n: number, start: number): string[] {
  const parts = spec
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  // "1-8" or "A1-A8" range shorthand
  if (parts.length === 1) {
    const m = /^([A-Za-z]*)(\d+)\s*-\s*\1?(\d+)$/.exec(parts[0]);
    if (m) {
      const a = Number(m[2]), b = Number(m[3]);
      const out: string[] = [];
      for (let i = a; out.length < n; i += a <= b ? 1 : -1) out.push(`${m[1]}${i}`);
      return out;
    }
  }
  return Array.from({ length: n }, (_, i) => parts[i] ?? String(start + i));
}

export function boxTemplate(name: string, o: BoxOpts): ElementDef {
  const p = Math.max(5, o.pitch);
  const n = Math.max(o.left, o.right, 1);
  const W = Math.max(20, Math.round(o.width / 20) * 20);
  const top = -p, bottom = (n - 1) * p + p;
  const prims: Prim[] = [rect(-W / 2, top, W, bottom - top)];
  const pins: PinDef[] = [];
  const L = labels(o.leftLabels, o.left, 1);
  const R = labels(o.rightLabels, o.right, o.left + 1);
  for (let i = 0; i < o.left; i++) {
    const y = i * p;
    prims.push(line(-W / 2 - 10, y, -W / 2, y));
    pins.push(pin(-W / 2 - 10, y, "w", L[i]));
    if (o.showNames) prims.push(text(-W / 2 + 2, y + 2, L[i], 5));
  }
  for (let i = 0; i < o.right; i++) {
    const y = i * p;
    prims.push(line(W / 2, y, W / 2 + 10, y));
    pins.push(pin(W / 2 + 10, y, "e", R[i]));
    if (o.showNames) prims.push(text(Math.round((W / 2 - 2 - approxMeasure(R[i], 5 * PT)) * 10) / 10, y + 2, R[i], 5));
  }
  prims.push(labelText(-W / 2, top - 18));
  const def = blankDef(name, { prims, pins, linkType: o.kind === "terminal" ? "simple" : "simple", info: { label: "" }, prefix: o.kind === "plc" ? "A" : "X" });
  if (o.kind === "plc") def.kind = { type: "simple" };
  return finalizeDef(def);
}

export function coilTemplate(name: string): ElementDef {
  const prims: Prim[] = [rect(-14, -8, 28, 16), line(0, -20, 0, -8), line(0, 8, 0, 20), labelText(18, -12)];
  const pins = [pin(0, -20, "n", "A1"), pin(0, 20, "s", "A2")];
  return finalizeDef(blankDef(name, { prims, pins, linkType: "master", kind: { type: "coil" }, info: { label: "" }, prefix: "K" }));
}

export function contactTemplate(name: string, o: ContactOpts): ElementDef {
  const nums = o.numbers.split(/[,;\s]+/).filter(Boolean);
  const [a, b] = [nums[0] ?? (o.state === "NO" ? "13" : "11"), nums[1] ?? (o.state === "NO" ? "14" : "12")];
  const prims: Prim[] = [line(0, -20, 0, -10), line(0, 10, 0, 20)];
  if (o.state === "NO") prims.push(line(0, 10, -8, -8));
  else prims.push(line(0, -10, 6, -10), line(0, 10, 8, -12));
  prims.push(labelText(8, -4));
  const pins = [pin(0, -20, "n", a), pin(0, 20, "s", b)];
  const slave = o.role === "slave";
  return finalizeDef(
    blankDef(name, {
      prims,
      pins,
      linkType: slave ? "slave" : "simple",
      kind: slave ? { type: "simple", state: o.state, number: "1" } : {},
      info: { label: "" },
      prefix: slave ? "" : "S",
    }),
  );
}

export function motorTemplate(name: string, o: MotorOpts): ElementDef {
  const prims: Prim[] = [ellipse(-15, -15, 30, 30), text(-5, 3, "M", 11), text(-5, 11, o.phases === 3 ? "3~" : "1~", 6)];
  const pins: PinDef[] = [];
  const xs = o.phases === 3 ? [-10, 0, 10] : [-5, 5];
  const names = o.phases === 3 ? ["U1", "V1", "W1"] : ["L", "N"];
  xs.forEach((x, i) => {
    const yc = -Math.sqrt(Math.max(0, 225 - x * x));
    prims.push(line(x, -30, x, Math.round(yc * 10) / 10));
    pins.push(pin(x, -30, "n", names[i]));
  });
  if (o.pe) {
    prims.push(line(20, 0, 15, 0), line(20, 0, 20, 10));
    pins.push(pin(20, 10, "s", "PE"));
  }
  prims.push(labelText(20, -28));
  return finalizeDef(blankDef(name, { prims, pins, linkType: "simple", info: { label: "" }, prefix: "M" }));
}

export function lampTemplate(name: string): ElementDef {
  const d = 7.07;
  const prims: Prim[] = [ellipse(-10, -10, 20, 20), line(-d, -d, d, d), line(-d, d, d, -d), line(0, -20, 0, -10), line(0, 10, 0, 20), labelText(14, -10)];
  const pins = [pin(0, -20, "n", "X1"), pin(0, 20, "s", "X2")];
  return finalizeDef(blankDef(name, { prims, pins, linkType: "simple", info: { label: "" }, prefix: "H" }));
}

export function blankTemplate(name: string): ElementDef {
  return finalizeDef(blankDef(name, { prims: [labelText(12, -20)], info: { label: "" } }));
}
