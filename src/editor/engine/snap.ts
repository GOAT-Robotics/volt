import type RBush from "rbush";
import type { Doc, ElemInst, Orient, Page, Pt } from "@/core/model";
import { dist, rotOrient, snapGrid, toScene } from "@/core/geometry";
import type { EndTarget } from "@/core/ops";
import { nearestSegment } from "@/core/wires";

export type IndexItem = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  kind: "el" | "wire" | "junc" | "text" | "etext" | "shape";
  id: string;
  seg?: number;
  sub?: string; // element text id
};

export type SnapKind = "pin" | "junction" | "wireEnd" | "wire" | "guide" | "grid" | "none";
export type Snap = {
  kind: SnapKind;
  p: Pt;
  target: EndTarget;
  label: string;
  orient?: Orient | null;
  guideX?: number;
  guideY?: number;
  /** the pin/junction already has connections → joining creates a junction dot */
  createsJunction?: boolean;
};

export type SnapOptions = {
  radius: number; // world units
  grid: number;
  order: ("pin" | "junction" | "wire" | "guide" | "grid")[];
  enabled: { pins: boolean; junctions: boolean; wires: boolean; guides: boolean; grid: boolean };
  excludeEls?: Set<string>;
  excludeWires?: Set<string>;
  /** guide references: points whose x/y we align to (e.g. wire start, other pins) */
  guideFrom?: Pt[];
  free?: boolean; // alt key: no snapping
};

export function pinDegree(page: Page): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of page.wires) for (const e of [w.a, w.b]) if (e.k === "pin") m.set(e.el + "/" + e.pin, (m.get(e.el + "/" + e.pin) ?? 0) + 1);
  return m;
}

export function snapPoint(doc: Doc, page: Page, index: RBush<IndexItem>, p: Pt, o: SnapOptions, elById: Map<string, ElemInst>, degree?: Map<string, number>): Snap {
  const gridP = { x: snapGrid(p.x, o.grid), y: snapGrid(p.y, o.grid) };
  if (o.free) return { kind: "none", p, target: { k: "free", p }, label: "" };
  const r = o.radius;
  const hits = index.search({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r });
  const cand: Partial<Record<SnapKind, Snap & { d: number }>> = {};
  const offer = (s: Snap & { d: number }) => {
    const k = s.kind === "wireEnd" ? "junction" : s.kind;
    const cur = cand[k];
    if (!cur || s.d < cur.d) cand[k] = { ...s, kind: s.kind };
  };
  const deg = degree ?? pinDegree(page);
  const seenEl = new Set<string>();
  for (const h of hits) {
    if (h.kind === "el" && o.enabled.pins && !seenEl.has(h.id) && !o.excludeEls?.has(h.id)) {
      seenEl.add(h.id);
      const e = elById.get(h.id);
      const def = e && doc.defs[e.defId];
      if (!e || !def) continue;
      for (const pin of def.pins) {
        const q = toScene(e, pin);
        const d = dist(p, q);
        if (d <= r) {
          const n = deg.get(e.id + "/" + pin.id) ?? 0;
          offer({
            kind: "pin",
            p: q,
            d,
            target: { k: "pin", el: e.id, pin: pin.id, p: q },
            label: `${e.info.label || def.name} · ${pin.number || pin.name || "pin"}`,
            orient: rotOrient(pin.orient, e.rot, e.mirror),
            createsJunction: n >= 2,
          });
        }
      }
    } else if (h.kind === "junc" && o.enabled.junctions) {
      const j = page.junctions.find((x) => x.id === h.id);
      if (!j) continue;
      const d = dist(p, j);
      if (d <= r) offer({ kind: "junction", p: { x: j.x, y: j.y }, d, target: { k: "junction", j: j.id, p: { x: j.x, y: j.y } }, label: "Junction", createsJunction: false });
    } else if (h.kind === "wire" && !o.excludeWires?.has(h.id)) {
      const w = page.wires.find((x) => x.id === h.id);
      if (!w) continue;
      // free ends
      if (o.enabled.junctions) {
        const ends: ["a" | "b", Pt][] = [["a", w.pts[0]], ["b", w.pts[w.pts.length - 1]]];
        for (const [end, q] of ends) {
          if (w[end].k !== "free") continue;
          const d = dist(p, q);
          if (d <= r) offer({ kind: "wireEnd", p: q, d, target: { k: "wireEnd", wire: w.id, end, p: q }, label: "Wire end" });
        }
      }
      if (o.enabled.wires && h.seg !== undefined) {
        const a = w.pts[h.seg], b = w.pts[h.seg + 1];
        if (!a || !b) continue;
        const n = nearestSegment([a, b], p);
        if (!n || n.d > r) continue;
        // keep the T-junction on the grid along the segment
        let q = n.p;
        if (Math.abs(a.y - b.y) < 0.01) q = { x: clamp(snapGrid(q.x, o.grid), a.x, b.x), y: a.y };
        else if (Math.abs(a.x - b.x) < 0.01) q = { x: a.x, y: clamp(snapGrid(q.y, o.grid), a.y, b.y) };
        offer({ kind: "wire", p: q, d: n.d, target: { k: "wire", wire: w.id, seg: h.seg, p: q }, label: w.label ? `Wire ${w.label}` : "Wire — creates junction", createsJunction: true });
      }
    }
  }
  // guides: align x/y with reference points
  if (o.enabled.guides && o.guideFrom?.length) {
    let gx: number | undefined, gy: number | undefined, dx = r, dy = r;
    for (const g of o.guideFrom) {
      if (Math.abs(g.x - p.x) < dx) (dx = Math.abs(g.x - p.x)), (gx = g.x);
      if (Math.abs(g.y - p.y) < dy) (dy = Math.abs(g.y - p.y)), (gy = g.y);
    }
    if (gx !== undefined || gy !== undefined) {
      const q = { x: gx ?? gridP.x, y: gy ?? gridP.y };
      offer({ kind: "guide", p: q, d: Math.min(dx, dy), target: { k: "free", p: q }, label: "Aligned", guideX: gx, guideY: gy });
    }
  }
  for (const k of o.order) {
    const key = (k === "junction" ? "junction" : k) as SnapKind;
    const c = cand[key];
    if (c) return c;
  }
  if (o.enabled.grid) return { kind: "grid", p: gridP, target: { k: "free", p: gridP }, label: "" };
  return { kind: "none", p, target: { k: "free", p }, label: "" };
}

const clamp = (v: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));
