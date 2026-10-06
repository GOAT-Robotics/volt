/**
 * Replace the symbol of placed components with another one (e.g. a one-pin end terminal with a
 * feed-through terminal), keeping position, reference, info and wires. Wires move to the new
 * symbol's pins: same pin number, else same direction, else the nearest pin; wires whose pin has
 * no counterpart keep their end where it was (free end).
 */
import type { Doc, ElemInst, ElementDef, Page, PinDef } from "./model";
import { ensureDef, ensureInstanceTexts, refreshAttached } from "./ops";

function mapPins(from: ElementDef, to: ElementDef, used: string[]): Map<string, string> {
  const m = new Map<string, string>();
  const free = to.pins.filter((p) => !used.includes(p.id));
  const take = (old: PinDef, pick: (p: PinDef) => boolean) => {
    const p = free.find(pick);
    if (!p) return false;
    m.set(old.id, p.id);
    free.splice(free.indexOf(p), 1);
    return true;
  };
  const olds = from.pins.filter((p) => used.includes(p.id));
  for (const o of olds) if (o.number && take(o, (p) => p.number === o.number)) continue;
  for (const o of olds) if (!m.has(o.id)) take(o, (p) => p.orient === o.orient);
  for (const o of olds)
    if (!m.has(o.id) && free.length) {
      const best = [...free].sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0];
      take(o, (p) => p === best);
    }
  return m;
}

export function replaceSymbol(doc: Doc, page: Page, el: ElemInst, def: ElementDef): { moved: number; loose: number } {
  const old = doc.defs[el.defId];
  if (!old || old.id === def.id) return { moved: 0, loose: 0 };
  ensureDef(doc, def);
  const used = [...new Set(page.wires.flatMap((w) => [w.a, w.b].filter((x) => x.k === "pin" && x.el === el.id).map((x) => (x as { pin: string }).pin)))];
  const map = mapPins(old, def, used);
  let moved = 0, loose = 0;
  // a one-pin symbol carries wires in both directions on its single pin: split them by the way they leave
  const up = def.pins.find((p) => p.orient === "n" || p.orient === "w");
  const down = def.pins.find((p) => p.orient === "s" || p.orient === "e");
  const split = old.pins.length === 1 && up && down && up !== down;
  for (const w of page.wires)
    for (const end of ["a", "b"] as const) {
      const we = w[end];
      if (we.k !== "pin" || we.el !== el.id) continue;
      let to = map.get(we.pin);
      if (split) {
        const pts = end === "a" ? w.pts : [...w.pts].reverse();
        const p1 = pts.find((q) => Math.abs(q.x - pts[0].x) + Math.abs(q.y - pts[0].y) > 0.5);
        if (p1) {
          const dx = p1.x - pts[0].x, dy = p1.y - pts[0].y;
          const r = (el.rot * 90 * Math.PI) / 180;
          // direction in the symbol's own frame
          const ly = -dx * Math.sin(r) + dy * Math.cos(r), lx = dx * Math.cos(r) + dy * Math.sin(r);
          const goesBack = Math.abs(ly) >= Math.abs(lx) ? ly < 0 : lx < 0;
          to = goesBack ? up!.id : down!.id;
        }
      }
      if (to) ((w[end] = { k: "pin", el: el.id, pin: to }), moved++);
      else ((w[end] = { k: "free" }), loose++);
    }
  el.defId = def.id;
  // keep the reference text (where it was dragged); the old symbol's own texts go, the new symbol's come
  const label = el.texts.find((t) => t.info === "label");
  el.texts = [];
  ensureInstanceTexts(def, el);
  if (label) {
    const i = el.texts.findIndex((t) => t.info === "label");
    if (i >= 0) el.texts[i] = { ...label, uuid: el.texts[i].uuid };
  }
  refreshAttached(doc, page, new Set([el.id]));
  return { moved, loose };
}
