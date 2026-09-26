import { describe, expect, it } from "vitest";
import type { Orient } from "../model";
import {
  applyMat,
  closestOnSeg,
  elemMatrix,
  GRID_ORIGIN,
  mulMat,
  normRect,
  orientVec,
  pointAlong,
  rotOrient,
  snapGrid,
  snapPt,
  toLocal,
  toScene,
  transformRect,
} from "../geometry";
import { near, rng } from "./helpers";

const ROTS = [0, 1, 2, 3] as const;
const MIRRORS = [false, true];
const combos = ROTS.flatMap((rot) => MIRRORS.map((mirror) => ({ rot, mirror })));

describe("toScene / toLocal", () => {
  it.each(combos)("are inverse for rot=$rot mirror=$mirror", ({ rot, mirror }) => {
    const r = rng(rot * 2 + (mirror ? 1 : 0) + 1);
    for (let i = 0; i < 200; i++) {
      const e = { x: r.int(-500, 500), y: r.int(-500, 500), rot, mirror };
      const p = { x: r.int(-100, 100) + r.next(), y: r.int(-100, 100) + r.next() };
      expect(near(toLocal(e, toScene(e, p)), p, 1e-9)).toBe(true);
      expect(near(toScene(e, toLocal(e, p)), p, 1e-9)).toBe(true);
    }
  });

  it("rotates clockwise on screen (y down) and mirrors horizontally before rotating", () => {
    const o = { x: 100, y: 50 };
    expect(toScene({ ...o, rot: 0, mirror: false }, { x: 10, y: 0 })).toEqual({ x: 110, y: 50 });
    expect(toScene({ ...o, rot: 1, mirror: false }, { x: 10, y: 0 })).toEqual({ x: 100, y: 60 });
    expect(toScene({ ...o, rot: 2, mirror: false }, { x: 10, y: 0 })).toEqual({ x: 90, y: 50 });
    expect(toScene({ ...o, rot: 3, mirror: false }, { x: 10, y: 0 })).toEqual({ x: 100, y: 40 });
    expect(toScene({ ...o, rot: 0, mirror: true }, { x: 10, y: 3 })).toEqual({ x: 90, y: 53 });
    expect(toScene({ ...o, rot: 1, mirror: true }, { x: 10, y: 0 })).toEqual({ x: 100, y: 40 });
  });

  it("hotspot maps to the element position", () => {
    for (const c of combos) expect(toScene({ x: 7, y: -3, ...c }, { x: 0, y: 0 })).toEqual({ x: 7, y: -3 });
  });
});

describe("elemMatrix", () => {
  it.each(combos)("equals toScene for rot=$rot mirror=$mirror", ({ rot, mirror }) => {
    const r = rng(42 + rot);
    for (let i = 0; i < 100; i++) {
      const e = { x: r.int(-300, 300), y: r.int(-300, 300), rot, mirror };
      const p = { x: r.int(-50, 50) + 0.25, y: r.int(-50, 50) - 0.5 };
      expect(near(applyMat(elemMatrix(e), p), toScene(e, p), 1e-9)).toBe(true);
    }
  });

  it("mulMat composes like function composition", () => {
    const a = elemMatrix({ x: 10, y: 20, rot: 1, mirror: true });
    const b = elemMatrix({ x: -5, y: 3, rot: 3, mirror: false });
    const p = { x: 4, y: -7 };
    expect(near(applyMat(mulMat(a, b), p), applyMat(a, applyMat(b, p)), 1e-9)).toBe(true);
  });

  it("transformRect gives the bounds of the transformed rectangle", () => {
    const r = { x: -10, y: -20, w: 20, h: 40 };
    for (const c of combos) {
      const e = { x: 100, y: 100, ...c };
      const t = transformRect(e, r);
      const corners = [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x, y: r.y + r.h },
        { x: r.x + r.w, y: r.y + r.h },
      ].map((p) => toScene(e, p));
      for (const p of corners) {
        expect(p.x).toBeGreaterThanOrEqual(t.x - 1e-9);
        expect(p.x).toBeLessThanOrEqual(t.x + t.w + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(t.y - 1e-9);
        expect(p.y).toBeLessThanOrEqual(t.y + t.h + 1e-9);
      }
      expect(t.w * t.h).toBeCloseTo(r.w * r.h);
    }
  });
});

describe("rotOrient", () => {
  const O: Orient[] = ["n", "e", "s", "w"];
  it("matches the transformed orientation vector for every combination", () => {
    for (const o of O)
      for (const c of combos) {
        const v = orientVec(o);
        const e = { x: 0, y: 0, ...c };
        const tv = toScene(e, v);
        expect(orientVec(rotOrient(o, c.rot, c.mirror))).toEqual({ x: tv.x + 0, y: tv.y + 0 });
      }
  });
  it("examples", () => {
    expect(rotOrient("n", 1, false)).toBe("e");
    expect(rotOrient("e", 0, true)).toBe("w");
    expect(rotOrient("n", 0, true)).toBe("n");
    expect(rotOrient("w", 3, false)).toBe("s");
  });
});

describe("snapGrid", () => {
  it("snaps to 10k + 5 (grid origin 5)", () => {
    expect(GRID_ORIGIN).toBe(5);
    expect(snapGrid(0, 10)).toBe(5);
    expect(snapGrid(9, 10)).toBe(5);
    expect(snapGrid(10.1, 10)).toBe(15);
    expect(snapGrid(15, 10)).toBe(15);
    expect(snapGrid(-3, 10)).toBe(-5);
    expect(snapGrid(-6, 10)).toBe(-5);
    expect(snapGrid(-11, 10)).toBe(-15);
    expect(snapPt({ x: 23, y: 101 }, 10)).toEqual({ x: 25, y: 105 });
  });
  it("is idempotent and moves by at most half a grid", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const v = (r.next() - 0.5) * 2000;
      const s = snapGrid(v, 10);
      expect(snapGrid(s, 10)).toBe(s);
      expect(Math.abs(s - v)).toBeLessThanOrEqual(5 + 1e-9);
      expect((((s - 5) % 10) + 10) % 10).toBeCloseTo(0);
    }
  });
});

describe("misc geometry", () => {
  it("closestOnSeg clamps to the segment", () => {
    expect(closestOnSeg({ x: -5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toMatchObject({ p: { x: 0, y: 0 }, t: 0 });
    expect(closestOnSeg({ x: 4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toMatchObject({ p: { x: 4, y: 0 }, d: 3 });
    expect(closestOnSeg({ x: 4, y: 3 }, { x: 1, y: 1 }, { x: 1, y: 1 }).p).toEqual({ x: 1, y: 1 });
  });
  it("pointAlong walks the polyline", () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }];
    expect(pointAlong(pts, 0).p).toEqual({ x: 0, y: 0 });
    expect(pointAlong(pts, 1).p).toEqual({ x: 10, y: 30 });
    const mid = pointAlong(pts, 0.5);
    expect(mid.p).toEqual({ x: 10, y: 10 });
    expect(mid.horizontal).toBe(false);
  });
  it("normRect normalises", () => {
    expect(normRect({ x: 10, y: 0 }, { x: 0, y: 5 })).toEqual({ x: 0, y: 0, w: 10, h: 5 });
  });
});
