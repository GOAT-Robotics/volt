import { describe, expect, it } from "vitest";
import type { Orient, Pt } from "../model";
import { autoRoute, isOrthogonal, joinAt, moveEndpoint, moveSegment, nearestSegment, orthoRoute, simplify, splitAt } from "../wires";
import { eqPt } from "../geometry";
import { near, rng } from "./helpers";

const ORIENTS: Orient[] = ["n", "e", "s", "w"];

/** Random orthogonal polyline (mostly alternating H/V; may continue straight or double back). */
function randomOrtho(r: ReturnType<typeof rng>, maxSeg = 6, backtrack = 0.25): Pt[] {
  const n = r.int(1, maxSeg);
  let h = r.next() < 0.5;
  const pts: Pt[] = [{ x: r.grid(-200, 200, 5), y: r.grid(-200, 200, 5) }];
  for (let i = 0; i < n; i++) {
    const last = pts[pts.length - 1];
    let d = r.grid(-100, 100, 5);
    if (d === 0) d = 10;
    pts.push(h ? { x: last.x + d, y: last.y } : { x: last.x, y: last.y + d });
    // sometimes keep the direction: the path continues or doubles back (QET pin stubs do this)
    if (r.next() >= backtrack) h = !h;
  }
  return pts;
}

const first = (p: Pt[]) => p[0];
const last = (p: Pt[]) => p[p.length - 1];

describe("orthoRoute", () => {
  it("is always orthogonal and connects the two points", () => {
    const r = rng(1);
    for (let i = 0; i < 2000; i++) {
      const a = { x: r.int(-300, 300), y: r.int(-300, 300) };
      const b = { x: r.int(-300, 300), y: r.int(-300, 300) };
      const ao = r.next() < 0.4 ? r.pick(ORIENTS) : null;
      const bo = r.next() < 0.4 ? r.pick(ORIENTS) : null;
      const hFirst = r.next() < 0.3 ? r.next() < 0.5 : undefined;
      const p = orthoRoute(a, b, ao, bo, hFirst);
      expect(isOrthogonal(p), JSON.stringify({ a, b, ao, bo, p })).toBe(true);
      expect(first(p)).toEqual(a);
      expect(last(p)).toEqual(b);
    }
  });
  it("leaves an oriented start pin along its axis", () => {
    const p = orthoRoute({ x: 0, y: 0 }, { x: 50, y: 70 }, "s", null);
    expect(p[1].x).toBe(0);
    const q = orthoRoute({ x: 0, y: 0 }, { x: 50, y: 70 }, "e", null);
    expect(q[1].y).toBe(0);
  });
  it("straight line when aligned", () => {
    expect(orthoRoute({ x: 0, y: 0 }, { x: 0, y: 40 })).toHaveLength(2);
  });
});

describe("autoRoute (QET generateConductorPath port)", () => {
  it("produces orthogonal paths between oriented pins for every orientation pair", () => {
    const r = rng(2);
    for (const ao of ORIENTS)
      for (const bo of ORIENTS)
        for (let i = 0; i < 150; i++) {
          const a = { x: r.grid(-400, 400, 10) + 5, y: r.grid(-400, 400, 10) + 5 };
          const b = { x: r.grid(-400, 400, 10) + 5, y: r.grid(-400, 400, 10) + 5 };
          if (eqPt(a, b)) continue;
          const p = autoRoute(a, ao, b, bo);
          expect(isOrthogonal(p), JSON.stringify({ a, ao, b, bo, p })).toBe(true);
          expect(first(p)).toEqual(a);
          expect(last(p)).toEqual(b);
          // no consecutive duplicates
          for (let k = 1; k < p.length; k++) expect(eqPt(p[k - 1], p[k])).toBe(false);
        }
  });
  it("is orthogonal for off-grid integer pins too", () => {
    const r = rng(3);
    for (let i = 0; i < 1000; i++) {
      const a = { x: r.int(-400, 400), y: r.int(-400, 400) };
      const b = { x: r.int(-400, 400), y: r.int(-400, 400) };
      const p = autoRoute(a, r.pick(ORIENTS), b, r.pick(ORIENTS));
      expect(isOrthogonal(p)).toBe(true);
      expect(first(p)).toEqual(a);
      expect(last(p)).toEqual(b);
    }
  });
  it("leaves each pin along its orientation", () => {
    const p = autoRoute({ x: 105, y: 105 }, "s", { x: 305, y: 405 }, "n");
    expect(p[1].x).toBe(105);
    expect(p[1].y).toBeGreaterThan(105);
    expect(p[p.length - 2].x).toBe(305);
    expect(p[p.length - 2].y).toBeLessThan(405);
  });
});

describe("moveEndpoint", () => {
  it("keeps orthogonality and the other endpoint fixed (property)", () => {
    const r = rng(4);
    for (let i = 0; i < 3000; i++) {
      const pts = randomOrtho(r);
      const which = r.next() < 0.5 ? "a" : "b";
      const to = { x: r.grid(-300, 300, 5), y: r.grid(-300, 300, 5) };
      const out = moveEndpoint(pts, which, to);
      const ctx = JSON.stringify({ pts, which, to, out });
      expect(isOrthogonal(out), ctx).toBe(true);
      if (which === "a") {
        expect(first(out), ctx).toEqual(to);
        expect(last(out), ctx).toEqual(last(pts));
      } else {
        expect(last(out), ctx).toEqual(to);
        expect(first(out), ctx).toEqual(first(pts));
      }
    }
  });
  it("tolerates non-normalized input (collinear interior points / duplicates)", () => {
    const r = rng(5);
    for (let i = 0; i < 2000; i++) {
      const base = randomOrtho(r);
      // insert redundant collinear midpoints and duplicate points
      const pts: Pt[] = [];
      base.forEach((p, k) => {
        if (k > 0 && r.next() < 0.5) {
          const q = base[k - 1];
          pts.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        }
        pts.push(p);
        if (r.next() < 0.2) pts.push({ ...p });
      });
      const which = r.next() < 0.5 ? "a" : "b";
      const to = { x: r.grid(-300, 300, 5), y: r.grid(-300, 300, 5) };
      const out = moveEndpoint(pts, which, to);
      const ctx = JSON.stringify({ pts, which, to, out });
      expect(isOrthogonal(out), ctx).toBe(true);
      expect(which === "a" ? first(out) : last(out), ctx).toEqual(to);
      expect(which === "a" ? last(out) : first(out), ctx).toEqual(which === "a" ? last(pts) : first(pts));
    }
  });
  it("keeps a straight wire straight when the move stays aligned", () => {
    const out = moveEndpoint([{ x: 0, y: 0 }, { x: 100, y: 0 }], "a", { x: 20, y: 0 });
    expect(out).toEqual([{ x: 20, y: 0 }, { x: 100, y: 0 }]);
  });
  it("does not mutate its input", () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const copy = JSON.parse(JSON.stringify(pts));
    moveEndpoint(pts, "b", { x: 70, y: 90 });
    expect(pts).toEqual(copy);
  });
});

describe("moveSegment", () => {
  it("keeps both endpoints fixed and stays orthogonal (property)", () => {
    const r = rng(6);
    for (let i = 0; i < 3000; i++) {
      const pts = randomOrtho(r);
      const seg = r.int(0, pts.length - 2);
      const d = { x: r.grid(-50, 50, 5), y: r.grid(-50, 50, 5) };
      const out = moveSegment(pts, seg, d);
      const ctx = JSON.stringify({ pts, seg, d, out });
      expect(first(out), ctx).toEqual(first(pts));
      expect(last(out), ctx).toEqual(last(pts));
      expect(isOrthogonal(out), ctx).toBe(true);
    }
  });
  it("moves the segment perpendicular to itself only", () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 50 }];
    const out = moveSegment(pts, 1, { x: 20, y: 999 });
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 50 }, { x: 100, y: 50 }]);
  });
  it("handles paths that double back on themselves", () => {
    // QET-style: pin stub up, long run down, stub up
    const pts = [{ x: 315, y: 235 }, { x: 315, y: 225 }, { x: 315, y: 395 }, { x: 315, y: 385 }];
    const out = moveSegment(pts, 1, { x: 20, y: 0 });
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[3]);
    expect(isOrthogonal(out)).toBe(true);
    const e = moveEndpoint(pts, "a", { x: 295, y: 225 });
    expect(e[0]).toEqual({ x: 295, y: 225 });
    expect(e[e.length - 1]).toEqual(pts[3]);
    expect(isOrthogonal(e)).toBe(true);
  });
  it("inserts stubs when dragging a single straight wire", () => {
    const out = moveSegment([{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, { x: 0, y: 30 });
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 0 }]);
  });
  it("ignores out-of-range segments", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    expect(moveSegment(pts, 5, { x: 1, y: 1 })).toEqual(pts);
  });
});

describe("splitAt / joinAt", () => {
  it("round-trips (property)", () => {
    const r = rng(8);
    for (let i = 0; i < 2000; i++) {
      const pts = randomOrtho(r);
      const seg = r.int(0, pts.length - 2);
      const a = pts[seg], b = pts[seg + 1];
      const t = r.next();
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const [p1, p2] = splitAt(pts, seg, p);
      const ctx = JSON.stringify({ pts, seg, p, p1, p2 });
      expect(first(p1), ctx).toEqual(first(pts));
      expect(last(p2), ctx).toEqual(last(pts));
      expect(near(last(p1), p), ctx).toBe(true);
      expect(near(first(p2), p), ctx).toBe(true);
      expect(joinAt(p1, p2, p), ctx).toEqual(simplify(pts));
      // either orientation of the halves is accepted
      expect(joinAt([...p1].reverse(), [...p2].reverse(), p), ctx).toEqual(simplify(pts));
    }
  });
  it("nearestSegment finds the hit segment", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(nearestSegment(pts, { x: 98, y: 60 })).toMatchObject({ i: 1, p: { x: 100, y: 60 }, d: 2 });
    expect(nearestSegment([{ x: 0, y: 0 }], { x: 1, y: 1 })).toBeNull();
  });
  it("simplify removes duplicates and collinear points", () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }])).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 5 },
    ]);
  });
});

describe("moveEndpoint degenerate cases", () => {
  it("always returns at least two points", () => {
    expect(moveEndpoint([{ x: 0, y: 0 }, { x: 50, y: 0 }], "a", { x: 50, y: 0 })).toHaveLength(2);
    expect(moveEndpoint([{ x: 5, y: 5 }, { x: 5, y: 5 }], "b", { x: 25, y: 45 })).toEqual(
      expect.arrayContaining([{ x: 5, y: 5 }, { x: 25, y: 45 }]),
    );
    const z = moveEndpoint([{ x: 5, y: 5 }, { x: 5, y: 5 }], "b", { x: 25, y: 45 });
    expect(z[0]).toEqual({ x: 5, y: 5 });
    expect(z[z.length - 1]).toEqual({ x: 25, y: 45 });
    expect(isOrthogonal(z)).toBe(true);
  });
});
