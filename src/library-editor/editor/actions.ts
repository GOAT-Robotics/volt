"use client";
import type { PinDef, Prim, Pt } from "@/core/model";
import { newUuid, symbolBounds } from "@/lib/library/elmt-tools";
import { useEd, withId, stripId, type EdPrim } from "./store";
import { clonePrimShifted, mirrorPin, mirrorPrim, r1, rotatePin, rotatePrim, selectionBounds, translatePrim } from "./geom";

const CLIP_KEY = "volt.symed.clipboard";
type Clip = { prims: Prim[]; pins: PinDef[] };

const selSet = () => new Set(useEd.getState().sel);

export function selectAll() {
  const d = useEd.getState().doc;
  useEd.getState().setSel([...d.prims.map((p) => p.id), ...d.pins.map((p) => p.id)]);
}

export function deleteSelection() {
  const s = selSet();
  if (!s.size) return;
  useEd.getState().change((d) => {
    d.prims = d.prims.filter((p) => !s.has(p.id));
    d.pins = d.pins.filter((p) => !s.has(p.id));
  });
  useEd.getState().setSel([]);
}

export function nudge(dx: number, dy: number) {
  const s = selSet();
  if (!s.size) return;
  useEd.getState().change(
    (d) => {
      for (const p of d.prims) if (s.has(p.id)) translatePrim(p as Prim, dx, dy);
      for (const p of d.pins) if (s.has(p.id)) (p.x = r1(p.x + dx)), (p.y = r1(p.y + dy));
    },
    "nudge",
  );
}

function center(): Pt | null {
  const st = useEd.getState();
  const s = new Set(st.sel);
  const b = selectionBounds(st.doc.prims, st.doc.pins, s);
  if (!b) return null;
  const g = st.grid;
  // snap the pivot so rotated geometry stays on grid
  return { x: Math.round((b.x + b.w / 2) / g) * g, y: Math.round((b.y + b.h / 2) / g) * g };
}

export function rotateSelection(dir: 1 | -1 = 1) {
  const s = selSet();
  const c = center();
  if (!s.size || !c) return;
  useEd.getState().change((d) => {
    for (const p of d.prims) if (s.has(p.id)) rotatePrim(p as Prim, c, dir);
    for (const p of d.pins) if (s.has(p.id)) rotatePin(p, c, dir);
  });
}

export function mirrorSelection(axis: "h" | "v") {
  const s = selSet();
  const c = center();
  if (!s.size || !c) return;
  useEd.getState().change((d) => {
    for (const p of d.prims) if (s.has(p.id)) mirrorPrim(p as Prim, axis, c);
    for (const p of d.pins) if (s.has(p.id)) mirrorPin(p, axis, c);
  });
}

export function copySelection(): boolean {
  const st = useEd.getState();
  const s = new Set(st.sel);
  if (!s.size) return false;
  const clip: Clip = { prims: st.doc.prims.filter((p) => s.has(p.id)).map(stripId), pins: st.doc.pins.filter((p) => s.has(p.id)) };
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(clip));
  } catch {}
  memClip = clip;
  return true;
}
let memClip: Clip | null = null;

export function cutSelection() {
  if (copySelection()) deleteSelection();
}

export function paste(offset = 10) {
  let clip = memClip;
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    if (raw) clip = JSON.parse(raw) as Clip;
  } catch {}
  if (!clip || (!clip.prims.length && !clip.pins.length)) return;
  insert(clip, offset);
}

function insert(clip: Clip, offset: number) {
  const st = useEd.getState();
  const used = new Set(st.doc.pins.map((p) => p.number));
  const prims: EdPrim[] = clip.prims.map((p) => withId(clonePrimShifted(p, offset, offset)));
  const pins: PinDef[] = clip.pins.map((p) => ({ ...p, id: newUuid(), x: r1(p.x + offset), y: r1(p.y + offset), number: bumpNumber(p.number, used) }));
  st.change((d) => {
    d.prims.push(...(prims as EdPrim[]));
    d.pins.push(...pins);
  });
  st.setSel([...prims.map((p) => p.id), ...pins.map((p) => p.id)]);
}

function bumpNumber(n: string, used: Set<string>): string {
  if (!n || !used.has(n)) {
    used.add(n);
    return n;
  }
  const m = /^(.*?)(\d+)$/.exec(n);
  let k = m ? Number(m[2]) + 1 : 2;
  const base = m ? m[1] : n;
  while (used.has(`${base}${k}`)) k++;
  used.add(`${base}${k}`);
  return `${base}${k}`;
}

export function duplicateSelection() {
  const st = useEd.getState();
  const s = new Set(st.sel);
  if (!s.size) return;
  insert({ prims: st.doc.prims.filter((p) => s.has(p.id)).map(stripId), pins: st.doc.pins.filter((p) => s.has(p.id)) }, st.grid >= 5 ? st.grid : 5);
}

export function zOrder(where: "front" | "back" | "forward" | "backward") {
  const s = selSet();
  if (!s.size) return;
  useEd.getState().change((d) => {
    const sel = d.prims.filter((p) => s.has(p.id));
    const rest = d.prims.filter((p) => !s.has(p.id));
    if (where === "front") d.prims = [...rest, ...sel];
    else if (where === "back") d.prims = [...sel, ...rest];
    else {
      const arr = [...d.prims];
      if (where === "forward") {
        for (let i = arr.length - 2; i >= 0; i--) if (s.has(arr[i].id) && !s.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      } else {
        for (let i = 1; i < arr.length; i++) if (s.has(arr[i].id) && !s.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
      }
      d.prims = arr;
    }
  });
}

/** Move the whole drawing so that its geometric centre sits on the grid-snapped origin. */
export function centerOnOrigin() {
  const st = useEd.getState();
  const b = symbolBounds({ prims: st.doc.prims, pins: st.doc.pins });
  if (!b) return;
  const g = 10;
  const dx = -Math.round((b.x + b.w / 2) / g) * g, dy = -Math.round((b.y + b.h / 2) / g) * g;
  if (!dx && !dy) return;
  st.change((d) => {
    for (const p of d.prims) translatePrim(p as Prim, dx, dy);
    for (const p of d.pins) (p.x = r1(p.x + dx)), (p.y = r1(p.y + dy));
  });
}

export function addPrims(prims: Prim[], select = true) {
  const eds = prims.map(withId);
  useEd.getState().change((d) => {
    d.prims.push(...(eds as EdPrim[]));
  });
  if (select) useEd.getState().setSel(eds.map((p) => p.id));
  return eds;
}

/** Pin grid used by the validator and by QET diagrams: conductors attach on a 5-unit grid. */
export const PIN_GRID = 5;
const offGrid = (v: number) => Math.abs(v - Math.round(v / PIN_GRID) * PIN_GRID) > 1e-6;
const snapG = (v: number) => Math.round(v / PIN_GRID) * PIN_GRID;

/**
 * Put every pin on the 5-unit grid.
 * 1) Shift the whole symbol (graphics + pins) by the offset that lands the most pins on-grid —
 *    this keeps the drawing intact when the pins share a common offset (the usual case).
 * 2) Any pin still off-grid (odd pitch) is snapped individually, and line endpoints that touched
 *    that pin are dragged along so the lead still meets the pin.
 */
export function snapPinsToGrid() {
  const st = useEd.getState();
  const pins = st.doc.pins;
  if (!pins.some((p) => offGrid(p.x) || offGrid(p.y))) return;
  const key = (dx: number, dy: number) => `${r1(dx)},${r1(dy)}`;
  const votes = new Map<string, { dx: number; dy: number; n: number }>();
  for (const p of pins) {
    const dx = r1(snapG(p.x) - p.x), dy = r1(snapG(p.y) - p.y);
    const k = key(dx, dy);
    const v = votes.get(k) ?? { dx, dy, n: 0 };
    v.n++;
    votes.set(k, v);
  }
  const best = [...votes.values()].sort((a, b) => b.n - a.n || Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy))[0];
  st.change((d) => {
    if (best.dx || best.dy) {
      for (const p of d.prims) translatePrim(p as Prim, best.dx, best.dy);
      for (const p of d.pins) (p.x = r1(p.x + best.dx)), (p.y = r1(p.y + best.dy));
    }
    const near = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) < 0.5 && Math.abs(ay - by) < 0.5;
    for (const p of d.pins) {
      if (!offGrid(p.x) && !offGrid(p.y)) continue;
      const ox = p.x, oy = p.y, nx = snapG(p.x), ny = snapG(p.y);
      for (const q of d.prims as Prim[]) {
        if (q.t !== "line") continue;
        if (near(q.x1, q.y1, ox, oy)) (q.x1 = nx), (q.y1 = ny);
        if (near(q.x2, q.y2, ox, oy)) (q.x2 = nx), (q.y2 = ny);
      }
      p.x = nx;
      p.y = ny;
    }
  }, "snap-pins");
}
