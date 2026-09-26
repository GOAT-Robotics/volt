import { readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { Doc, ElementDef, Page, PinDef, Pt, Orient } from "../model";
import { newDoc } from "../doc";
import { parseElmt } from "../qet";
import { endPoint } from "../topology";
import { isOrthogonal } from "../wires";

export const FIX = path.join(__dirname, "..", "qet", "__fixtures__");
export const readFixtureElmt = (f: string) => readFileSync(path.join(FIX, "elements", f), "utf8");
export const readFixtureQet = (f: string) => readFileSync(path.join(FIX, "projects", f), "utf8");
export const fixtureDef = (f: string): ElementDef => parseElmt(readFixtureElmt(f), { id: "fix:" + f });

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    grid: (lo: number, hi: number, g = 10) => lo + Math.floor(next() * ((hi - lo) / g + 1)) * g,
    pick: <T,>(a: readonly T[]): T => a[Math.floor(next() * a.length)],
  };
}

export type PinSpec = { id: string; x: number; y: number; orient: Orient; number?: string; name?: string; required?: boolean };

/** Synthetic element definition: a box with the given pins. */
export function mkDef(id: string, pins: PinSpec[], o: Partial<ElementDef> = {}): ElementDef {
  const style = { lineStyle: "normal", lineWeight: "normal", filling: "none", color: "black" } as const;
  return {
    id,
    uuid: id,
    name: o.name ?? id,
    names: { en: o.name ?? id },
    width: 20,
    height: 40,
    hotspotX: 10,
    hotspotY: 20,
    linkType: "simple",
    prefix: "K",
    category: "",
    prims: [{ t: "rect", x: -8, y: -15, w: 16, h: 30, rx: 0, ry: 0, style: { ...style } }],
    pins: pins.map(
      (p): PinDef => ({ id: p.id, x: p.x, y: p.y, orient: p.orient, name: p.name ?? "", number: p.number ?? p.id, type: "Generic", required: p.required }),
    ),
    info: {},
    kind: {},
    meta: {},
    ...o,
  };
}

/** Two-pin vertical component (top pin "1" facing north, bottom pin "2" facing south). */
export const twoPin = (id = "two", o: Partial<ElementDef> = {}) =>
  mkDef(id, [
    { id: "1", x: 0, y: -20, orient: "n" },
    { id: "2", x: 0, y: 20, orient: "s" },
  ], o);

/** Four-pin component with pins on every side. */
export const fourPin = (id = "four", o: Partial<ElementDef> = {}) =>
  mkDef(id, [
    { id: "n", x: 0, y: -20, orient: "n" },
    { id: "e", x: 10, y: 0, orient: "e" },
    { id: "s", x: 0, y: 20, orient: "s" },
    { id: "w", x: -10, y: 0, orient: "w" },
  ], o);

export function mkDoc(autoOnPlace = false): { doc: Doc; page: Page } {
  const doc = newDoc("Test");
  doc.numbering.autoOnPlace = autoOnPlace;
  return { doc, page: doc.pages[0] };
}

export const near = (a: Pt, b: Pt, eps = 1e-6) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

/** Every attached wire end sits exactly on its pin / junction and every wire is orthogonal. */
export function expectWiresConsistent(doc: Doc, page: Page, opts: { orthogonal?: boolean } = {}) {
  for (const w of page.wires) {
    expect(w.pts.length, `wire ${w.id} has < 2 points`).toBeGreaterThanOrEqual(2);
    for (const end of ["a", "b"] as const) {
      const we = w[end];
      if (we.k === "free") continue;
      const p = endPoint(doc, page, we);
      expect(p, `wire ${w.id}.${end} references a missing ${we.k}`).not.toBeNull();
      const cur = end === "a" ? w.pts[0] : w.pts[w.pts.length - 1];
      expect(near(cur, p!, 1e-6), `wire ${w.id}.${end} at ${JSON.stringify(cur)} but attachment at ${JSON.stringify(p)}`).toBe(true);
    }
    if (opts.orthogonal !== false) expect(isOrthogonal(w.pts), `wire ${w.id} not orthogonal: ${JSON.stringify(w.pts)}`).toBe(true);
  }
}
