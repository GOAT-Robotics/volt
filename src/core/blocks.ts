import type { BlockContent, Doc, ElemInst, ElementDef, GroupRef, Page, PinDef, Prim, Pt, Rect, WireEnd } from "./model";
import { copySelection, pasteClip, type Clip, type Sel, emptySel, cleanupJunctions, refreshAttached } from "./ops";
import { elementBounds } from "./render/scene";
import { ptsBBox, rotOrient, snapGrid, toScene, unionRect } from "./geometry";
import { uid } from "./ids";
import { computeNets } from "./topology";

/* ------------------------------------------------------------------ */
/* Reusable blocks                                                      */
/* ------------------------------------------------------------------ */

export type PortSuggestion = { name: string; x: number; y: number; el: string; pin: string };

/** Build block content from a selection: coordinates relative to the snapped bbox origin. */
export function buildBlock(doc: Doc, page: Page, sel: Sel): { content: BlockContent; ports: PortSuggestion[] } {
  const clip = copySelection(doc, page, sel);
  let bb: Rect | null = null;
  for (const e of clip.elements) bb = unionRect(bb, elementBounds(e, doc.defs[e.defId]));
  for (const w of clip.wires) bb = unionRect(bb, ptsBBox(w.pts));
  const r = bb ?? { x: 0, y: 0, w: 0, h: 0 };
  const origin = { x: snapGrid(r.x, 10), y: snapGrid(r.y, 10) };
  const shift = (p: Pt) => ({ x: p.x - origin.x, y: p.y - origin.y });
  const inSel = new Set(sel.elements);
  // ports: pins of selected elements wired to something outside, or unconnected
  const nets = computeNets(page);
  const ports: PortSuggestion[] = [];
  const connectedPins = new Set<string>();
  for (const n of nets) for (const p of n.pins) connectedPins.add(p.el + "/" + p.pin);
  for (const e of clip.elements) {
    const def = doc.defs[e.defId];
    for (const pin of def.pins) {
      const key = e.id + "/" + pin.id;
      const net = nets.find((n) => n.pins.some((p) => p.el + "/" + p.pin === key));
      const external = net ? net.pins.some((p) => !inSel.has(p.el)) : true;
      if (!external) continue;
      const sp = toScene(e, pin);
      ports.push({ name: `${e.info.label || def.name}:${pin.number || pin.name || String(def.pins.indexOf(pin) + 1)}`, ...shift(sp), el: e.id, pin: pin.id });
    }
  }
  const content: BlockContent = {
    defs: clip.defs,
    elements: clip.elements.map((e) => ({ ...e, x: e.x - origin.x, y: e.y - origin.y, group: undefined })),
    wires: clip.wires.map((w) => ({ ...w, pts: w.pts.map(shift), group: undefined })),
    junctions: clip.junctions.map((j) => ({ ...j, ...shift(j), group: undefined })),
    texts: clip.texts.map((t) => ({ ...t, ...shift(t) })),
    ports: ports.map(({ name, x, y, el, pin }) => ({ name, x, y, el, pin })),
    bbox: { x: 0, y: 0, w: r.w, h: r.h },
  };
  return { content, ports };
}

/** Place a block instance; every created item carries the group ref. Returns the new selection. */
export function placeBlock(doc: Doc, page: Page, blockId: string, revision: number, name: string, content: BlockContent, at: Pt, mode: GroupRef["mode"]): Sel {
  const clip: Clip = { defs: content.defs, elements: content.elements, wires: content.wires, junctions: content.junctions, texts: content.texts };
  const sel = pasteClip(doc, page, clip, at, true);
  if (mode === "independent") return sel;
  const gid = uid();
  const srcByNew = new Map<string, string>();
  // pasteClip preserves order, so map by index
  sel.elements.forEach((id, i) => srcByNew.set(id, content.elements[i].id));
  sel.wires.forEach((id, i) => srcByNew.set(id, content.wires[i].id));
  sel.junctions.forEach((id, i) => srcByNew.set(id, content.junctions[i].id));
  const g = (id: string): GroupRef => ({ id: gid, blockId, revision, mode, name, origin: at, src: srcByNew.get(id) });
  for (const e of page.elements) if (sel.elements.includes(e.id)) e.group = g(e.id);
  for (const w of page.wires) if (sel.wires.includes(w.id)) w.group = g(w.id);
  for (const j of page.junctions) if (sel.junctions.includes(j.id)) j.group = g(j.id);
  return sel;
}

/**
 * Update a linked / derived block instance to new block content.
 * Elements keep their instance ids (so external wires stay attached); derived instances keep their
 * references and properties, linked ones take everything from the block except the reference.
 */
export function updateBlockInstance(doc: Doc, page: Page, groupId: string, revision: number, content: BlockContent): { added: number; removed: number; updated: number } {
  const items = page.elements.filter((e) => e.group?.id === groupId);
  const any = items[0]?.group ?? page.wires.find((w) => w.group?.id === groupId)?.group;
  if (!any) return { added: 0, removed: 0, updated: 0 };
  const origin = any.origin ?? { x: 0, y: 0 };
  for (const [id, d] of Object.entries(content.defs)) doc.defs[id] = d;
  const bySrc = new Map(items.map((e) => [e.group!.src, e]));
  const srcToInst = new Map<string, string>();
  let added = 0, updated = 0, removed = 0;
  const keep = new Set<string>();
  for (const be of content.elements) {
    const cur = bySrc.get(be.id);
    const g: GroupRef = { ...any, revision, src: be.id };
    if (cur) {
      cur.defId = be.defId;
      cur.x = be.x + origin.x;
      cur.y = be.y + origin.y;
      cur.rot = be.rot;
      cur.mirror = be.mirror;
      if (any.mode === "linked") {
        const label = cur.info.label;
        cur.info = { ...be.info, label: label ?? "" };
        cur.texts = be.texts.map((t) => ({ ...t, id: uid() }));
      }
      cur.group = g;
      keep.add(cur.id);
      srcToInst.set(be.id, cur.id);
      updated++;
    } else {
      const n: ElemInst = { ...JSON.parse(JSON.stringify(be)), id: uid(), x: be.x + origin.x, y: be.y + origin.y, group: g };
      page.elements.push(n);
      keep.add(n.id);
      srcToInst.set(be.id, n.id);
      added++;
    }
  }
  for (const e of items)
    if (!keep.has(e.id)) {
      page.elements = page.elements.filter((x) => x.id !== e.id);
      removed++;
    }
  // replace internal wires & junctions
  page.wires = page.wires.filter((w) => w.group?.id !== groupId);
  page.junctions = page.junctions.filter((j) => j.group?.id !== groupId);
  const jmap = new Map<string, string>();
  for (const j of content.junctions) {
    const id = uid();
    jmap.set(j.id, id);
    page.junctions.push({ ...j, id, x: j.x + origin.x, y: j.y + origin.y, group: { ...any, revision, src: j.id } });
  }
  const remap = (we: WireEnd): WireEnd =>
    we.k === "pin" ? (srcToInst.has(we.el) ? { k: "pin", el: srcToInst.get(we.el)!, pin: we.pin } : { k: "free" }) : we.k === "junction" ? (jmap.has(we.j) ? { k: "junction", j: jmap.get(we.j)! } : { k: "free" }) : we;
  for (const w of content.wires) page.wires.push({ ...w, id: uid(), a: remap(w.a), b: remap(w.b), pts: w.pts.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })), group: { ...any, revision, src: w.id } });
  // external wires to pins that no longer exist → dangling
  const elIds = new Set(page.elements.map((e) => e.id));
  for (const w of page.wires)
    for (const k of ["a", "b"] as const) {
      const end = w[k];
      if (end.k !== "pin") continue;
      const el = page.elements.find((e) => e.id === end.el);
      if (!elIds.has(end.el) || !doc.defs[el!.defId]?.pins.some((p) => p.id === end.pin)) w[k] = { k: "free" };
    }
  // instance elements may have moved / rotated / changed pins: rubber-band the external wires still attached
  refreshAttached(doc, page, keep);
  cleanupJunctions(page);
  return { added, removed, updated };
}

export function detachGroup(page: Page, groupId: string) {
  for (const e of page.elements) if (e.group?.id === groupId) e.group = undefined;
  for (const w of page.wires) if (w.group?.id === groupId) w.group = undefined;
  for (const j of page.junctions) if (j.group?.id === groupId) j.group = undefined;
}

export function groupSelection(page: Page, groupId: string): Sel {
  const s = emptySel();
  s.elements = page.elements.filter((e) => e.group?.id === groupId).map((e) => e.id);
  s.wires = page.wires.filter((w) => w.group?.id === groupId).map((w) => w.id);
  s.junctions = page.junctions.filter((j) => j.group?.id === groupId).map((j) => j.id);
  return s;
}

/* ------------------------------------------------------------------ */
/* Merge selected components into a new element definition             */
/* ------------------------------------------------------------------ */

function tPrim(p: Prim, e: ElemInst, o: Pt): Prim | null {
  const T = (q: Pt) => {
    const s = toScene(e, q);
    return { x: s.x - o.x, y: s.y - o.y };
  };
  const rotDeg = e.rot * 90;
  switch (p.t) {
    case "line": {
      const a = T({ x: p.x1, y: p.y1 }), b = T({ x: p.x2, y: p.y2 });
      return { ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case "rect":
    case "ellipse": {
      const a = T({ x: p.x, y: p.y }), b = T({ x: p.x + p.w, y: p.y + p.h });
      return { ...p, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) } as Prim;
    }
    case "arc": {
      const a = T({ x: p.x, y: p.y }), b = T({ x: p.x + p.w, y: p.y + p.h });
      // QET angles are CCW on screen; a CW element rotation subtracts; mirroring reflects
      let start = p.start, angle = p.angle;
      if (e.mirror) {
        start = 180 - start - angle;
      }
      start -= rotDeg;
      return { ...p, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), start: ((start % 360) + 360) % 360, angle };
    }
    case "polygon":
      return { ...p, pts: p.pts.map(T) };
    case "text": {
      const a = T({ x: p.x, y: p.y });
      return { ...p, x: a.x, y: a.y, rotation: (p.rotation + rotDeg) % 360 };
    }
    case "dyntext":
      return null; // instance-specific texts are not merged
  }
}

/** Merge the symbols of selected elements into one definition (pins = all pins). */
export function mergeToDef(doc: Doc, page: Page, elIds: string[], name: string): ElementDef {
  const els = page.elements.filter((e) => elIds.includes(e.id));
  let bb: Rect | null = null;
  for (const e of els) bb = unionRect(bb, elementBounds(e, doc.defs[e.defId]));
  const r = bb ?? { x: 0, y: 0, w: 20, h: 20 };
  const origin = { x: snapGrid(r.x + r.w / 2, 10), y: snapGrid(r.y + r.h / 2, 10) };
  const prims: Prim[] = [];
  const pins: PinDef[] = [];
  let n = 0;
  for (const e of els) {
    const def = doc.defs[e.defId];
    for (const p of def.prims) {
      const t = tPrim(p, e, origin);
      if (t) prims.push(t);
    }
    for (const pin of def.pins) {
      const s = toScene(e, pin);
      pins.push({ id: uid(), x: s.x - origin.x, y: s.y - origin.y, orient: rotOrient(pin.orient, e.rot, e.mirror), name: pin.name, number: pin.number || String(++n), type: pin.type });
    }
  }
  const x0 = Math.floor(r.x - origin.x), y0 = Math.floor(r.y - origin.y);
  return {
    id: uid(),
    uuid: uid(),
    name,
    names: { en: name },
    width: Math.ceil(r.w) + 2,
    height: Math.ceil(r.h) + 2,
    hotspotX: -x0 + 1,
    hotspotY: -y0 + 1,
    linkType: "simple",
    prefix: "",
    category: "",
    prims,
    pins,
    info: {},
    kind: { type: "simple" },
    meta: {},
  };
}
