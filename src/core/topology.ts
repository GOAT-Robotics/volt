import type { Doc, ElemInst, Page, Pt, Wire, WireEnd } from "./model";
import { toScene } from "./geometry";
import { pageMateLinks } from "./mating";

export const endKey = (e: WireEnd): string | null => (e.k === "pin" ? `p:${e.el}/${e.pin}` : e.k === "junction" ? `j:${e.j}` : null);

/** Scene position of a wire end's attachment (null for free ends). */
export function endPoint(doc: Doc, page: Page, e: WireEnd, elIndex?: Map<string, ElemInst>): Pt | null {
  if (e.k === "pin") {
    const el = elIndex ? elIndex.get(e.el) : page.elements.find((x) => x.id === e.el);
    const def = el && doc.defs[el.defId];
    const pin = def?.pins.find((p) => p.id === e.pin);
    return el && pin ? toScene(el, pin) : null;
  }
  if (e.k === "junction") {
    const j = page.junctions.find((x) => x.id === e.j);
    return j ? { x: j.x, y: j.y } : null;
  }
  return null;
}

class DSU {
  p = new Map<string, string>();
  find(a: string): string {
    let r = this.p.get(a) ?? a;
    if (r !== a) {
      r = this.find(r);
      this.p.set(a, r);
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

export type Net = { id: string; pins: { el: string; pin: string }[]; junctions: string[]; wires: string[] };

/**
 * Electrical nets of a page: nodes are pins and junctions, edges are wires (and, with `doc`,
 * the pin pairs of mated connectors on the page).
 */
export function computeNets(page: Page, doc?: Doc): Net[] {
  const d = new DSU();
  const wireNode = (w: Wire) => `w:${w.id}`;
  // every pin / junction node touched by a wire (DSU roots are not stored in d.p, so track them here)
  const nodes = new Set<string>();
  for (const w of page.wires) {
    const a = endKey(w.a), b = endKey(w.b);
    if (a) d.union(wireNode(w), a), nodes.add(a);
    if (b) d.union(wireNode(w), b), nodes.add(b);
    d.find(wireNode(w));
  }
  if (doc)
    for (const [a, b] of pageMateLinks(doc, page)) {
      // only pins that carry wires on both sides need joining; the others would be empty nets
      if (nodes.has(a) || nodes.has(b)) {
        d.union(a, b);
        nodes.add(a);
        nodes.add(b);
      }
    }
  const nets = new Map<string, Net>();
  const get = (k: string) => {
    const r = d.find(k);
    let n = nets.get(r);
    if (!n) nets.set(r, (n = { id: r, pins: [], junctions: [], wires: [] }));
    return n;
  };
  for (const w of page.wires) get(wireNode(w)).wires.push(w.id);
  for (const k of nodes) {
    if (k.startsWith("p:")) {
      const [el, pin] = k.slice(2).split("/");
      get(k).pins.push({ el, pin });
    } else if (k.startsWith("j:")) get(k).junctions.push(k.slice(2));
  }
  return [...nets.values()].filter((n) => n.wires.length);
}

/** Canonical connectivity signature: set of pin-sets per net (used to detect connectivity changes). */
export function connectivitySignature(page: Page): string[] {
  return computeNets(page)
    .map((n) => n.pins.map((p) => `${p.el}/${p.pin}`).sort().join("|"))
    .filter((s) => s.includes("|"))
    .sort();
}

export function connectivityDiff(before: Page, after: Page): { added: string[]; removed: string[] } {
  const a = new Set(connectivitySignature(before));
  const b = new Set(connectivitySignature(after));
  return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) };
}

/** Wires attached to an element (with which end). */
export function wiresOfElement(page: Page, elId: string): { w: Wire; end: "a" | "b" }[] {
  const out: { w: Wire; end: "a" | "b" }[] = [];
  for (const w of page.wires) {
    if (w.a.k === "pin" && w.a.el === elId) out.push({ w, end: "a" });
    if (w.b.k === "pin" && w.b.el === elId) out.push({ w, end: "b" });
  }
  return out;
}

export function wiresOfJunction(page: Page, jId: string): { w: Wire; end: "a" | "b" }[] {
  const out: { w: Wire; end: "a" | "b" }[] = [];
  for (const w of page.wires) {
    if (w.a.k === "junction" && w.a.j === jId) out.push({ w, end: "a" });
    if (w.b.k === "junction" && w.b.j === jId) out.push({ w, end: "b" });
  }
  return out;
}
