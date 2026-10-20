/**
 * Straighten wires: line components up with what they are wired to, then draw every wire that can
 * be straight as a straight line (and, optionally, re-route the others with the fewest bends).
 *
 * Wires get bends when the pins at their two ends are not in line — e.g. a connector drawn at 146 %
 * (pins 14.6 apart, off the grid) wired to a device with pins 20 apart, or off-page arrows placed by
 * eye. Moving the right components fixes that:
 *  - each component (with a mated plug / socket drawn on top of it) is shifted along the axis its
 *    wires leave by — up / down for pins facing left / right — by the amount that lines up the most
 *    of its wires with their other ends;
 *  - components are taken in dependency order: first those wired to things that stay put (devices,
 *    junctions, locked or unselected components), then those wired to the ones just moved, so a chain
 *    arrow → connector → device lines up in one go.
 * Wires are then drawn straight where their ends are in line — never through another symbol — and,
 * with `reroute`, the others get the route with the fewest bends. No component moves further than
 * `maxShift`, onto another component, or while locked.
 * Mutates the given (immer draft) document.
 */
import type { Doc, ElemInst, Orient, Page, Pt, Wire, WireEnd } from "./model";
import { GRID_ORIGIN, rotOrient, toScene } from "./geometry";
import { cleanupJunctions, mkSel, moveSelection, scaleElements } from "./ops";
import { elementBounds } from "./render/scene";
import { orthoRoute, simplify } from "./wires";

export type StraightenOptions = {
  /** components that may move (ids); none = only redraw wires */
  move?: string[];
  /** wires to redraw (ids); default: the wires of the moved components, or every wire of the page when nothing moves */
  wires?: string[];
  /** wires that cannot be straight: re-route them with the fewest bends (default: leave their path, only tidy it) */
  reroute?: boolean;
  /** components (that may move) drawn at a size putting their pins off the grid get a grid-friendly size (default true) */
  fixSizes?: boolean;
  /** largest move of a component, in scene units (default 100: a little more than a row of the usual border) */
  maxShift?: number;
};
export type StraightenResult = {
  moved: { id: string; dx: number; dy: number; lined: number; of: number }[];
  /** components given a size at which their pins land on the grid (percent) */
  resized: { id: string; from: number; to: number }[];
  /** components that could not move (locked) or had nothing to line up with */
  stayed: { id: string; why: string }[];
  straight: string[];
  /** could be straight, but the straight line would cross another symbol */
  blocked: string[];
  rerouted: string[];
  tidied: string[];
  /** components whose pins are off the grid (usually: drawn at a size such as 146 %) */
  offGrid: { id: string; scale: number }[];
};

const EPS = 0.5;
const horizontal = (o: Orient | null) => o === "e" || o === "w";
/** the direction a pin points to, in scene coordinates */
function pinOrient(doc: Doc, e: ElemInst, pinId: string): Orient | null {
  const pin = doc.defs[e.defId]?.pins.find((p) => p.id === pinId);
  return pin ? rotOrient(pin.orient, e.rot, e.mirror) : null;
}
function pinPoint(doc: Doc, e: ElemInst, pinId: string): Pt | null {
  const pin = doc.defs[e.defId]?.pins.find((p) => p.id === pinId);
  return pin ? toScene(e, pin) : null;
}

type End = { p: Pt; o: Orient | null; el: string | null };
function endOf(doc: Doc, page: Page, w: Wire, end: "a" | "b", els: Map<string, ElemInst>): End | null {
  const e: WireEnd = w[end];
  if (e.k === "pin") {
    const el = els.get(e.el);
    if (!el) return null;
    const p = pinPoint(doc, el, e.pin);
    return p ? { p, o: pinOrient(doc, el, e.pin), el: el.id } : null;
  }
  if (e.k === "junction") {
    const j = page.junctions.find((x) => x.id === e.j);
    if (j) return { p: { x: j.x, y: j.y }, o: null, el: null };
    // a junction that no longer exists: the end stays where it is drawn
  }
  const p = end === "a" ? w.pts[0] : w.pts[w.pts.length - 1];
  return { p, o: null, el: null };
}

/** can a straight line from `a` (pointing `a.o`) reach `b`? */
function straightOk(a: End, b: End): boolean {
  const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y;
  const inLineH = Math.abs(dy) < EPS, inLineV = Math.abs(dx) < EPS;
  if (!inLineH && !inLineV) return false;
  const faces = (e: End, tx: number, ty: number) => {
    if (!e.o) return true;
    if (e.o === "e") return inLineH && tx > -EPS;
    if (e.o === "w") return inLineH && tx < EPS;
    if (e.o === "s") return inLineV && ty > -EPS;
    return inLineV && ty < EPS;
  };
  return faces(a, dx, dy) && faces(b, -dx, -dy);
}

const onGrid = (v: number, g: number) => Math.abs((v - GRID_ORIGIN) / g - Math.round((v - GRID_ORIGIN) / g)) < 1e-6;

/** components of a page whose pins are not on the grid */
export function offGridComponents(doc: Doc, page: Page): { id: string; scale: number }[] {
  const g = doc.grid?.size || 10;
  const out: { id: string; scale: number }[] = [];
  for (const e of page.elements) {
    const def = doc.defs[e.defId];
    if (!def || def.name === "volt_junction" || !def.pins.length) continue;
    const bad = def.pins.some((p) => {
      const s = toScene(e, p);
      return !onGrid(s.x, g) || !onGrid(s.y, g);
    });
    if (bad && e.scale && e.scale !== 1) out.push({ id: e.id, scale: e.scale });
  }
  return out;
}

/** sizes (percent) between 50 and 300 at which the component's pins land on the grid */
export function gridFriendlyScales(doc: Doc, e: ElemInst): number[] {
  const def = doc.defs[e.defId];
  if (!def) return [];
  const g = doc.grid?.size || 10;
  const out: number[] = [];
  for (let pct = 50; pct <= 300; pct += 5) {
    const k = pct / 100;
    const ok = def.pins.every((p) => {
      const s = toScene({ ...e, scale: k }, p);
      return onGrid(s.x, g) && onGrid(s.y, g);
    });
    if (ok) out.push(pct);
  }
  return out;
}

export function straightenWires(doc: Doc, page: Page, o: StraightenOptions = {}): StraightenResult {
  const res: StraightenResult = { moved: [], resized: [], stayed: [], straight: [], blocked: [], rerouted: [], tidied: [], offGrid: [] };
  // paths as they were, so a wire counts as straightened only when it was not straight already
  const wasStraight = new Set(
    page.wires.filter((w) => {
      const p = simplify(w.pts);
      return p.length === 2 && (Math.abs(p[0].x - p[1].x) < EPS || Math.abs(p[0].y - p[1].y) < EPS);
    }).map((w) => w.id),
  );
  const maxShift = o.maxShift ?? 100;
  const els = () => new Map(page.elements.map((e) => [e.id, e]));
  const isLoop = (w: Wire) => w.a.k === "junction" && w.b.k === "junction" && w.a.j === w.b.j;
  const isJunctionEl = (e: ElemInst) => doc.defs[e.defId]?.name === "volt_junction";

  // ---------------------------------------------------------------- line up components
  const want = new Set((o.move ?? []).filter((id) => page.elements.some((e) => e.id === id && !isJunctionEl(e))));
  // a mated plug and socket drawn on top of each other move together
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const id of want) {
    if (seen.has(id)) continue;
    const e = page.elements.find((x) => x.id === id)!;
    const g = [id];
    const m = e.mate ? page.elements.find((x) => x.id === e.mate!.id) : undefined;
    if (m && Math.abs(m.x - e.x) < EPS && Math.abs(m.y - e.y) < EPS) g.push(m.id);
    g.forEach((x) => seen.add(x));
    groups.push(g);
  }
  const locked = groups.filter((g) => g.some((id) => page.elements.find((e) => e.id === id)?.locked));
  for (const g of locked) res.stayed.push({ id: g[0], why: "locked in place" });
  const pending = groups.filter((g) => !locked.includes(g));

  /**
   * The best move of group `g` (at its size, or at `scale`): the shift that puts the most of its
   * wires in line with their other ends — without taking any wire that is in line now out of line.
   * Wires to components that may still move (`skip`) do not count yet. `gain` = wires in line after
   * minus before.
   */
  /** does component `id` (with its mated half) have a straight wire other than `except` that does not go to `mine`? */
  const anchored = (id: string, except: string, mine: Set<string>, idx: Map<string, ElemInst>) => {
    const own = new Set([id, idx.get(id)?.mate?.id ?? ""]);
    return page.wires.some((w) => {
      if (w.id === except || isLoop(w)) return false;
      const ends = (["a", "b"] as const).filter((k) => { const x = w[k]; return x.k === "pin" && own.has(x.el); });
      if (ends.length !== 1) return false;
      const far = ends[0] === "a" ? "b" : "a";
      const fe = w[far];
      if (fe.k === "pin" && mine.has(fe.el)) return false;
      const A = endOf(doc, page, w, ends[0], idx), B = endOf(doc, page, w, far, idx);
      return !!A && !!B && straightOk(A, B);
    });
  };

  const bestMove = (g: string[], skip: Set<string>, scale?: number) => {
    const mine = new Set(g);
    const idx = els();
    const need: { key: string | null; now: boolean }[] = [];
    for (const w of page.wires) {
      if (isLoop(w)) continue;
      for (const [near, far] of [["a", "b"], ["b", "a"]] as const) {
        const ne = w[near];
        if (ne.k !== "pin" || !mine.has(ne.el)) continue;
        const fe = w[far];
        if (fe.k === "pin" && mine.has(fe.el)) continue; // inside the group
        const el = idx.get(ne.el)!;
        const pin = doc.defs[el.defId]?.pins.find((p) => p.id === ne.pin);
        const B = endOf(doc, page, w, far, idx);
        if (!pin || !B) continue;
        const now: End = { p: toScene(el, pin), o: rotOrient(pin.orient, el.rot, el.mirror), el: el.id };
        if (fe.k === "pin" && skip.has(fe.el)) {
          // the other end may still move (and follow), so this wire is no reason to move — but a straight
          // one must stay straight when its other end cannot follow without bending a wire of its own
          if (straightOk(now, B) && anchored(fe.el, w.id, mine, idx)) need.push({ key: null, now: true });
          continue;
        }
        const A: End = { ...now, p: scale ? toScene({ ...el, scale }, pin) : now.p };
        const entry = { key: null as string | null, now: straightOk(now, B) };
        need.push(entry);
        const h = horizontal(A.o);
        if (B.o && horizontal(B.o) !== h) continue;
        const d = h ? B.p.y - A.p.y : B.p.x - A.p.x;
        // the other end must be on the side the pin faces — and, if it is a pin, face back
        const ahead = h ? (A.o === "e" ? B.p.x - A.p.x : A.p.x - B.p.x) : A.o === "s" ? B.p.y - A.p.y : A.p.y - B.p.y;
        if (ahead < -EPS) continue;
        if (B.o && !(h ? (B.o === "w" && B.p.x > A.p.x - EPS) || (B.o === "e" && B.p.x < A.p.x + EPS) : (B.o === "n" && B.p.y > A.p.y - EPS) || (B.o === "s" && B.p.y < A.p.y + EPS))) continue;
        // a junction or loose end keeps the direction the wire comes in from (e.g. from below into a drawn box)
        if (!B.o && approach(w, far) === (h ? "v" : "h")) continue;
        if (Math.abs(d) > maxShift + EPS) continue; // too far: lining up is a layout decision, not a tidy-up
        // lined up, the wire would run straight through another symbol: that is not a straight wire either
        const shifted = h ? { x: A.p.x, y: A.p.y + d } : { x: A.p.x + d, y: A.p.y };
        const around = new Set<string>([...g, ...[fe.k === "pin" ? fe.el : ""].filter(Boolean)]);
        for (const id of [...around]) {
          const m = idx.get(id)?.mate?.id;
          if (m) around.add(m);
        }
        if (crosses(doc, page, [shifted, B.p], around)) continue;
        // nor would one running along another wire
        if (amongWires(page, [shifted, B.p], w.id).overlap) continue;
        entry.key = h ? `0,${round(d)}` : `${round(d)},0`;
      }
    }
    const of = need.length;
    const before = need.filter((x) => x.now).length;
    let best: { dx: number; dy: number; votes: number; of: number; gain: number } | null = null;
    for (const key of new Set(need.map((x) => x.key).filter((k): k is string => !!k))) {
      const votes = need.filter((x) => x.key === key).length;
      const lost = need.filter((x) => x.now && x.key !== key).length;
      if (lost) continue;
      const [dx, dy] = key.split(",").map(Number);
      const gain = votes - before;
      if (!best || gain > best.gain || (gain === best.gain && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) best = { dx, dy, votes, of, gain };
    }
    return { best, of, before };
  };

  // components drawn at a size that puts their pins off the grid get the grid-friendly size that
  // lines up more of their wires than now (never one that takes a straight wire out of line)
  if (o.fixSizes !== false) {
    const g0 = doc.grid?.size || 10;
    for (const g of pending) {
      const e = page.elements.find((x) => x.id === g[0])!;
      const def = doc.defs[e.defId];
      if (!def || !e.scale || e.scale === 1) continue;
      if (def.pins.every((p) => { const q = toScene(e, p); return onGrid(q.x, g0) && onGrid(q.y, g0); })) continue;
      const others = new Set<string>();
      const here = bestMove(g, others);
      const atNow = here.before + Math.max(0, here.best?.gain ?? 0);
      const scored = gridFriendlyScales(doc, e)
        .map((pct) => ({ pct, m: bestMove(g, others, pct / 100) }))
        .filter((x) => x.m.best && x.m.best.votes > atNow && (x.m.best.votes >= 2 || x.m.of <= 1))
        .sort((p, q) => q.m.best!.votes - p.m.best!.votes || Math.abs(p.pct / 100 - e.scale!) - Math.abs(q.pct / 100 - e.scale!));
      const best = scored[0];
      if (!best) continue;
      const from = e.scale;
      scaleElements(doc, page, g, () => best.pct / 100);
      res.resized.push({ id: g[0], from: Math.round(from * 100), to: best.pct });
    }
  }

  // move groups one by one: the one lining up the most wires with settled ends first
  const blocked = new Set<string[]>();
  let relaxed = false;
  for (let guard = 0; pending.length && guard < 10_000; guard++) {
    const busy = new Set(pending.flat());
    const cands = pending
      .filter((g) => !blocked.has(g))
      .map((g) => ({ g, m: bestMove(g, relaxed ? new Set<string>() : busy) }))
      .sort((p, q) => (q.m.best?.gain ?? -1) - (p.m.best?.gain ?? -1) || (p.m.best ? Math.abs(p.m.best.dx) + Math.abs(p.m.best.dy) : 0) - (q.m.best ? Math.abs(q.m.best.dx) + Math.abs(q.m.best.dy) : 0));
    let acted = false;
    for (const c of cands) {
      const { g, m } = c;
      const v = m.best;
      if (!m.of) continue; // nothing settled to line up with yet
      if (!v || v.gain <= 0 || (!v.dx && !v.dy)) {
        pending.splice(pending.indexOf(g), 1);
        res.stayed.push({ id: g[0], why: m.before === m.of ? `already in line (${m.before} of ${m.of} wires)` : m.before ? `${m.before} of ${m.of} wires in line; moving would take one out of line` : "no move lines its wires up" });
        acted = true;
        break;
      }
      // one wire of several in line is no improvement: the pins do not match what they connect to
      if (v.votes < 2 && v.of > 1) {
        pending.splice(pending.indexOf(g), 1);
        res.stayed.push({ id: g[0], why: `would line up only 1 of ${v.of} wires — its pins are spaced differently from what they connect to` });
        acted = true;
        break;
      }
      const hit = overlapAfter(doc, page, g, v.dx, v.dy);
      if (hit) {
        blocked.add(g);
        continue;
      }
      moveSelection(doc, page, mkSel({ elements: g }), { x: v.dx, y: v.dy });
      pending.splice(pending.indexOf(g), 1);
      res.moved.push({ id: g[0], dx: v.dx, dy: v.dy, lined: v.votes, of: v.of });
      blocked.clear();
      relaxed = false;
      acted = true;
      break;
    }
    if (acted) continue;
    if (!relaxed) {
      // nothing is wired to settled ends (e.g. a connector between two arrows): line up with the others
      relaxed = true;
      blocked.clear();
      continue;
    }
    break;
  }
  for (const g of pending) {
    const v = bestMove(g, new Set()).best;
    const hit = v && (v.dx || v.dy) && v.gain > 0 ? overlapAfter(doc, page, g, v.dx, v.dy) : null;
    res.stayed.push({ id: g[0], why: hit ? `would overlap ${page.elements.find((e) => e.id === hit)?.info.label || "another component"}` : "no wire it could be lined up with" });
  }
  res.offGrid = offGridComponents(doc, page);

  // ---------------------------------------------------------------- redraw wires
  const moved = new Set(res.moved.flatMap((m) => groups.find((g) => g[0] === m.id) ?? [m.id]));
  const scope = new Set(
    o.wires?.length
      ? o.wires
      : want.size
        ? page.wires.filter((w) => [w.a, w.b].some((e) => e.k === "pin" && (moved.has(e.el) || want.has(e.el)))).map((w) => w.id)
        : page.wires.map((w) => w.id),
  );
  const idx = els();
  const g = doc.grid?.size || 10;
  for (const w of page.wires) {
    if (!scope.has(w.id) || isLoop(w)) continue;
    const A = endOf(doc, page, w, "a", idx), B = endOf(doc, page, w, "b", idx);
    if (!A || !B) continue;
    const before = JSON.stringify(w.pts);
    // the parts at the ends (and their mated halves) may touch the wire; nothing else may
    const skip = new Set<string>();
    for (const id of [A.el, B.el]) {
      if (!id) continue;
      skip.add(id);
      const m = idx.get(id)?.mate?.id;
      if (m) skip.add(m);
    }
    if (straightOk(A, B)) {
      const line = [{ ...A.p }, { ...B.p }];
      const axis = Math.abs(A.p.y - B.p.y) < EPS ? "h" : "v";
      // a junction or loose end keeps the direction the wire comes in from
      const turned = (!A.o && approach(w, "a") === (axis === "h" ? "v" : "h")) || (!B.o && approach(w, "b") === (axis === "h" ? "v" : "h"));
      if (!turned && !crosses(doc, page, line, skip) && !amongWires(page, line, w.id).overlap) {
        w.pts = line;
        if (!wasStraight.has(w.id)) res.straight.push(w.id);
        continue;
      }
      if (despike(simplify(w.pts)).length > 2) res.blocked.push(w.id);
    }
    if (o.reroute && (w.a.k !== "free" || w.b.k !== "free")) {
      // the route with the fewest bends that leaves each pin the way it points and crosses no symbol
      const h = A.o ? horizontal(A.o) : B.o ? horizontal(B.o) : Math.abs(B.p.x - A.p.x) >= Math.abs(B.p.y - A.p.y);
      const mid = (v: number) => Math.round((v - GRID_ORIGIN) / g) * g + GRID_ORIGIN;
      const cands = [
        orthoRoute(A.p, B.p, A.o, B.o),
        [A.p, { x: B.p.x, y: A.p.y }, B.p],
        [A.p, { x: A.p.x, y: B.p.y }, B.p],
        h ? [A.p, { x: mid((A.p.x + B.p.x) / 2), y: A.p.y }, { x: mid((A.p.x + B.p.x) / 2), y: B.p.y }, B.p] : [A.p, { x: A.p.x, y: mid((A.p.y + B.p.y) / 2) }, { x: B.p.x, y: mid((A.p.y + B.p.y) / 2) }, B.p],
      ]
        .map((c) => simplify(c))
        .filter((c) => c.length >= 2 && leaves(A, c[1]) && leaves(B, c[c.length - 2]) && !crosses(doc, page, c, skip))
        .sort((p, q) => p.length - q.length);
      const now = despike(simplify(w.pts));
      // never along another wire, and across no more of them than now
      const crossed = amongWires(page, now, w.id).crossings;
      const pick = cands.find((c) => c.length < now.length && ((h) => !h.overlap && h.crossings <= crossed)(amongWires(page, c, w.id)));
      if (pick) {
        w.pts = pick;
        res.rerouted.push(w.id);
        continue;
      }
    }
    // keep the route, drop doubled-back stubs and needless corners
    const tidy = despike(simplify(w.pts));
    if (tidy.length >= 2 && JSON.stringify(tidy) !== before) {
      w.pts = tidy;
      res.tidied.push(w.id);
    }
  }
  cleanupJunctions(page);
  return res;
}

/**
 * Drop points where the path runs back along itself (A → B → back towards A on the same line), as
 * imported QElectroTech wires often do at pins: they draw nothing visible but count as bends.
 */
export function despike(pts: Pt[]): Pt[] {
  const out = pts.map((p) => ({ ...p }));
  let again = true;
  while (again && out.length > 2) {
    again = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      const sameX = Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS;
      const sameY = Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS;
      const dup = Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
      if (sameX || sameY || dup) {
        out.splice(i, 1);
        again = true;
        break;
      }
    }
  }
  if (out.length === 2 && Math.abs(out[0].x - out[1].x) < EPS && Math.abs(out[0].y - out[1].y) < EPS) return pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : pts;
  return out;
}

/** the axis of the segment a wire reaches one of its ends along (doubled-back stubs ignored) */
function approach(w: Wire, end: "a" | "b"): "h" | "v" | null {
  const pts = despike(simplify(w.pts));
  if (pts.length < 2) return null;
  const [p, q] = end === "a" ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
  if (Math.abs(p.y - q.y) < EPS && Math.abs(p.x - q.x) >= EPS) return "h";
  if (Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) >= EPS) return "v";
  return null;
}

/** the first step of a route leaves (or enters) an end the way its pin points */
function leaves(e: End, next: Pt): boolean {
  if (!e.o) return true;
  const dx = next.x - e.p.x, dy = next.y - e.p.y;
  if (e.o === "e") return Math.abs(dy) < EPS && dx > -EPS;
  if (e.o === "w") return Math.abs(dy) < EPS && dx < EPS;
  if (e.o === "s") return Math.abs(dx) < EPS && dy > -EPS;
  return Math.abs(dx) < EPS && dy < EPS;
}

/** does an orthogonal path run through the symbol of a component other than those in `skip`? */
function crosses(doc: Doc, page: Page, pts: Pt[], skip: Set<string>): boolean {
  for (const e of page.elements) {
    if (skip.has(e.id) || e.hidden) continue;
    const def = doc.defs[e.defId];
    if (!def || def.name === "volt_junction") continue;
    const r = elementBounds(e, def);
    if (r.w < 6 && r.h < 6) continue; // splices, connection points
    const x0 = r.x + 1, x1 = r.x + r.w - 1, y0 = r.y + 1, y1 = r.y + r.h - 1;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (Math.abs(a.y - b.y) < EPS) {
        if (a.y > y0 && a.y < y1 && Math.max(a.x, b.x) > x0 && Math.min(a.x, b.x) < x1) return true;
      } else if (a.x > x0 && a.x < x1 && Math.max(a.y, b.y) > y0 && Math.min(a.y, b.y) < y1) return true;
    }
  }
  return false;
}

/**
 * How a path sits among the page's other wires: `overlap` = it runs along one of them (which reads
 * as a connection that is not there), `crossings` = how many of their segments it crosses.
 */
function amongWires(page: Page, pts: Pt[], self: string): { overlap: boolean; crossings: number } {
  let crossings = 0;
  for (const w of page.wires) {
    if (w.id === self) continue;
    for (let j = 0; j < w.pts.length - 1; j++) {
      const c = w.pts[j], d = w.pts[j + 1];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const aH = Math.abs(a.y - b.y) < EPS, cH = Math.abs(c.y - d.y) < EPS;
        const aV = Math.abs(a.x - b.x) < EPS, cV = Math.abs(c.x - d.x) < EPS;
        if (aH && cH && Math.abs(a.y - c.y) < EPS) {
          if (Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) > 1) return { overlap: true, crossings };
        } else if (aV && cV && Math.abs(a.x - c.x) < EPS) {
          if (Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) > 1) return { overlap: true, crossings };
        } else if (aH && cV) {
          if (c.x > Math.min(a.x, b.x) + EPS && c.x < Math.max(a.x, b.x) - EPS && a.y > Math.min(c.y, d.y) + EPS && a.y < Math.max(c.y, d.y) - EPS) crossings++;
        } else if (aV && cH) {
          if (a.x > Math.min(c.x, d.x) + EPS && a.x < Math.max(c.x, d.x) - EPS && c.y > Math.min(a.y, b.y) + EPS && c.y < Math.max(a.y, b.y) - EPS) crossings++;
        }
      }
    }
  }
  return { overlap: false, crossings };
}

/** the first component a group would overlap after moving by (dx, dy) */
function overlapAfter(doc: Doc, page: Page, g: string[], dx: number, dy: number): string | null {
  const mine = new Set(g);
  const boxes = g.map((id) => {
    const e = page.elements.find((x) => x.id === id)!;
    const def = doc.defs[e.defId];
    const r = def ? elementBounds(e, def) : { x: e.x, y: e.y, w: 0, h: 0 };
    return { x: r.x + dx + 1, y: r.y + dy + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) };
  });
  for (const e of page.elements) {
    if (mine.has(e.id)) continue;
    const def = doc.defs[e.defId];
    if (!def || def.name === "volt_junction") continue;
    const r = elementBounds(e, def);
    if (boxes.some((b) => b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h)) return e.id;
  }
  return null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const magnitude = (key: string) => key.split(",").reduce((s, v) => s + Math.abs(Number(v)), 0);
