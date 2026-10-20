/**
 * Reading a Volt drawing for an AI assistant: addressing (pages, components, pins, wires by the
 * names engineers use) and compact text views. No server dependencies (unit tested).
 *
 * Addresses
 *  - page: its number ("2", in sheet order), its title, or its id
 *  - component: its reference ("K1"); a reference shared by several parts of one device (coil
 *    and contacts) means the device, "K1@2" the part on page 2; "#1a2b3c4d" an element by id
 *  - pin: "K1:A1" (reference + pin number or name), terminals "X1:3:1"; "#1a2b3c4d:A1"
 *  - wire: "#1a2b3c4d" (id), or its wire number when only one conductor carries it
 * Ids are shown as the first 8 characters ("#1a2b3c4d"); any unique prefix of 6+ characters works.
 */
import type { Doc, ElemInst, ElementDef, Page, PinDef, Pt, Wire } from "@/core/model";
import { projectNets, checkElectrical, indexElements } from "@/core/erc";
import { validateDoc } from "@/core/validate";
import { gridRef } from "@/core/xref";
import { wireInfo, wiringOf, STANDARDS, wirePot, wireUse } from "@/core/wiring";
import { wireNumberingOf } from "@/core/wirenumber";
import { rotOrient, toScene } from "@/core/geometry";
import { collectStrips } from "@/core/terminals";
import { gridFriendlyScales, offGridComponents } from "@/core/straighten";
import { componentLabels } from "@/core/label-place";
import { docStyles } from "@/core/render/scene";
import { approxMeasure } from "@/core/render/svg";

export class AddressError extends Error {}

export const short = (id: string) => "#" + id.replace(/-/g, "").slice(0, 8);
const idKey = (id: string) => id.replace(/-/g, "").toLowerCase();
const isJunctionDef = (d: ElementDef | undefined) => d?.name === "volt_junction";
const isReport = (d: ElementDef | undefined) => d?.linkType === "next_report" || d?.linkType === "previous_report";

export const sheets = (doc: Doc) => [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
export const sheetNo = (doc: Doc, page: Page) => sheets(doc).indexOf(page) + 1;

/* ------------------------------------------------------------------ */
/* Addressing                                                           */
/* ------------------------------------------------------------------ */

export function findPage(doc: Doc, ref: string | number | undefined | null): Page {
  const list = sheets(doc);
  if (ref === undefined || ref === null || ref === "") {
    if (list.length === 1) return list[0];
    throw new AddressError(`Which page? The drawing has ${list.length}: ${list.map((p, i) => `${i + 1} "${p.title}"`).join(", ")}`);
  }
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const p = list[Number(s) - 1];
    if (p) return p;
  }
  const byId = doc.pages.find((p) => p.id === s || p.id === s.replace(/^#/, ""));
  if (byId) return byId;
  const byTitle = list.filter((p) => p.title.trim().toLowerCase() === s.toLowerCase());
  if (byTitle.length === 1) return byTitle[0];
  throw new AddressError(`No page "${s}". Pages: ${list.map((p, i) => `${i + 1} "${p.title}"`).join(", ")}`);
}

export type Located = { e: ElemInst; page: Page; def: ElementDef | undefined };

function byIdPrefix<T extends { id: string }>(items: T[], s: string, what: string): T[] {
  const k = idKey(s.replace(/^#/, ""));
  if (k.length < 6) throw new AddressError(`"${s}": give at least 6 characters of the ${what} id`);
  return items.filter((x) => idKey(x.id).startsWith(k));
}

export function allElements(doc: Doc): Located[] {
  const out: Located[] = [];
  for (const page of sheets(doc)) for (const e of page.elements) {
    const def = doc.defs[e.defId];
    if (isJunctionDef(def)) continue;
    out.push({ e, page, def });
  }
  return out;
}

/** every part a component address means (one element, or all parts of a device) */
export function findComponents(doc: Doc, ref: string): Located[] {
  const s = ref.trim();
  if (!s) throw new AddressError("Give a component reference, e.g. K1");
  const all = allElements(doc);
  if (s.startsWith("#")) {
    const hit = byIdPrefix(all.map((x) => ({ ...x, id: x.e.id })), s, "component");
    if (hit.length === 1) return [hit[0]];
    throw new AddressError(hit.length ? `"${s}" matches ${hit.length} components — give more characters` : `No component with id ${s}`);
  }
  const at = /^(.*)@(\d+)$/.exec(s);
  const label = (at ? at[1] : s).trim();
  let hits = all.filter((x) => (x.e.info.label ?? "").trim() === label);
  if (!hits.length) hits = all.filter((x) => (x.e.info.label ?? "").trim().toLowerCase() === label.toLowerCase());
  if (at) hits = hits.filter((x) => sheetNo(doc, x.page) === Number(at[2]));
  if (!hits.length) {
    const near = [...new Set(all.map((x) => x.e.info.label ?? "").filter((l) => l && l.toLowerCase().startsWith(label.slice(0, 1).toLowerCase())))].slice(0, 15);
    throw new AddressError(`No component "${s}"${near.length ? `. References starting with ${label.slice(0, 1)}: ${near.join(", ")}` : ""}`);
  }
  return hits;
}

/** the parts plus elements linked to them without a reference of their own (QElectroTech contacts of a coil) */
export function withLinkedParts(doc: Doc, parts: Located[]): Located[] {
  const ids = new Set(parts.map((x) => x.e.id));
  const extra = allElements(doc).filter((x) => !ids.has(x.e.id) && !x.e.info.label?.trim() && ((x.e.links ?? []).some((l) => ids.has(l)) || parts.some((p) => (p.e.links ?? []).includes(x.e.id))));
  return [...parts, ...extra];
}

/** exactly one element (a part) */
export function findComponent(doc: Doc, ref: string): Located {
  const hits = findComponents(doc, ref);
  if (hits.length === 1) return hits[0];
  throw new AddressError(`"${ref}" has ${hits.length} parts: ${hits.map((x) => `${x.e.info.label}@${sheetNo(doc, x.page)} (${x.def?.name ?? "?"}, ${short(x.e.id)})`).join(", ")} — say which, e.g. ${ref}@${sheetNo(doc, hits[0].page)}`);
}

/** a pin's name for people: its number, else its name, else its position on the symbol ("p1", "p2" …) */
const pinLabel = (p: PinDef, def?: ElementDef) => p.number || p.name || (def ? `p${def.pins.indexOf(p) + 1}` : p.id.length <= 8 ? p.id : "?");
function matchPin(def: ElementDef | undefined, spec: string): PinDef | null {
  if (!def) return null;
  const s = spec.trim().toLowerCase();
  const pos = /^p(\d+)$/.exec(s);
  return (
    def.pins.find((p) => (p.number ?? "").toLowerCase() === s) ??
    def.pins.find((p) => (p.name ?? "").toLowerCase() === s) ??
    def.pins.find((p) => p.id.toLowerCase() === s) ??
    (pos && !def.pins[Number(pos[1]) - 1]?.number && !def.pins[Number(pos[1]) - 1]?.name ? def.pins[Number(pos[1]) - 1] ?? null : null)
  );
}

export type PinAt = Located & { pin: PinDef };

/** "K1:A1", "X1:3:1", "K1@2:13", "#1a2b3c4d:A1" */
export function findPin(doc: Doc, spec: string): PinAt {
  const s = spec.trim();
  const tries: { comp: string; pin: string | null }[] = [];
  for (let i = s.lastIndexOf(":"); i > 0; i = s.lastIndexOf(":", i - 1)) tries.push({ comp: s.slice(0, i), pin: s.slice(i + 1) });
  tries.push({ comp: s, pin: null });
  const errors: string[] = [];
  for (const t of tries) {
    let parts: Located[];
    try {
      parts = findComponents(doc, t.comp);
    } catch {
      continue;
    }
    if (t.pin === null) {
      const withPins = parts.filter((x) => x.def?.pins.length);
      if (withPins.length === 1 && withPins[0].def!.pins.length === 1) return { ...withPins[0], pin: withPins[0].def!.pins[0] };
      errors.push(`${t.comp} has pins ${parts.flatMap((x) => x.def?.pins.map((p) => `${t.comp}:${pinLabel(p, x.def)}`) ?? []).join(", ")} — say which`);
      continue;
    }
    const hits = parts.map((x) => ({ ...x, pin: matchPin(x.def, t.pin!) })).filter((x): x is PinAt => !!x.pin);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      errors.push(`${s} is on ${hits.length} parts: ${hits.map((h) => `${h.e.info.label}@${sheetNo(doc, h.page)}:${pinLabel(h.pin, h.def)}`).join(", ")}`);
      continue;
    }
    errors.push(`${t.comp} has no pin "${t.pin}" (pins: ${[...new Set(parts.flatMap((x) => x.def?.pins.map((p) => pinLabel(p, x.def)) ?? []))].join(", ") || "none"})`);
  }
  throw new AddressError(errors[0] ?? `No component for "${s}"`);
}

export type WireAt = { w: Wire; page: Page };
export function allWires(doc: Doc): WireAt[] {
  return sheets(doc).flatMap((page) => page.wires.map((w) => ({ w, page })));
}

/** "#1a2b3c4d" or a wire number carried by one conductor */
export function findWires(doc: Doc, spec: string): WireAt[] {
  const s = spec.trim();
  const all = allWires(doc);
  if (s.startsWith("#") || /^[0-9a-f-]{8,}$/i.test(s)) {
    const hit = byIdPrefix(all.map((x) => ({ ...x, id: x.w.id })), s, "wire");
    if (hit.length === 1) return [hit[0]];
    if (s.startsWith("#")) throw new AddressError(hit.length ? `"${s}" matches ${hit.length} wires — give more characters` : `No wire with id ${s}`);
  }
  const byLabel = all.filter((x) => (x.w.label ?? "").trim() === s);
  if (byLabel.length) return byLabel;
  throw new AddressError(`No wire "${s}" — use a wire id from list_wires (e.g. #1a2b3c4d) or a wire number`);
}

/* ------------------------------------------------------------------ */
/* Positions                                                            */
/* ------------------------------------------------------------------ */

/** "3C" (border column 3, row C) → centre of that cell; or {x, y} as given */
export function positionOf(doc: Doc, page: Page, at: { cell?: string; x?: number; y?: number }): Pt {
  if (at.cell) {
    const m = /^\s*(\d+)\s*([A-Za-z])\s*$/.exec(at.cell);
    if (!m) throw new AddressError(`Cell "${at.cell}" — write column number then row letter, e.g. 3C`);
    const b = page.border;
    const hx = b.showRows ? b.headerW : 0, hy = b.showCols ? b.headerH : 0;
    const col = Number(m[1]), row = m[2].toUpperCase().charCodeAt(0) - 65;
    if (col < 1 || col > b.cols || row < 0 || row >= b.rows) throw new AddressError(`Cell ${at.cell} is outside the sheet (columns 1–${b.cols}, rows A–${String.fromCharCode(64 + b.rows)})`);
    return snap(doc, { x: hx + (col - 0.5) * b.colW, y: hy + (row + 0.5) * b.rowH });
  }
  if (typeof at.x === "number" && typeof at.y === "number") return snap(doc, { x: at.x, y: at.y });
  throw new AddressError("Give a position: cell (e.g. 3C) or x and y");
}
/** the area of a border cell ("3C"): its top-left and bottom-right corners */
export function cellArea(page: Page, cell: string): { a: Pt; b: Pt } {
  const m = /^\s*(\d+)\s*([A-Za-z])\s*$/.exec(cell);
  if (!m) throw new AddressError(`Cell "${cell}" — write column number then row letter, e.g. 3C`);
  const b = page.border;
  const hx = b.showRows ? b.headerW : 0, hy = b.showCols ? b.headerH : 0;
  const col = Number(m[1]), row = m[2].toUpperCase().charCodeAt(0) - 65;
  if (col < 1 || col > b.cols || row < 0 || row >= b.rows) throw new AddressError(`Cell ${cell} is outside the sheet (columns 1–${b.cols}, rows A–${String.fromCharCode(64 + b.rows)})`);
  return { a: { x: hx + (col - 1) * b.colW, y: hy + row * b.rowH }, b: { x: hx + col * b.colW, y: hy + (row + 1) * b.rowH } };
}
const snap = (doc: Doc, p: Pt): Pt => {
  const g = doc.grid?.size || 10;
  return { x: Math.round((p.x - 5) / g) * g + 5, y: Math.round((p.y - 5) / g) * g + 5 };
};

/* ------------------------------------------------------------------ */
/* Text views                                                           */
/* ------------------------------------------------------------------ */

const INFO_NAMES: Record<string, string> = { description: "name", rating: "rating", manufacturer_reference: "part", manufacturer: "maker", location: "location", function: "function", comment: "comment", supplier: "supplier", quantity: "qty" };
const HIDDEN_INFO = new Set(["label", "formula"]);
export function infoText(e: ElemInst, keys?: string[]) {
  return Object.entries(e.info)
    .filter(([k, v]) => !HIDDEN_INFO.has(k) && v && String(v).trim() && (!keys || keys.includes(k)))
    .map(([k, v]) => `${INFO_NAMES[k] ?? k}=${String(v).replace(/\s+/g, " ").slice(0, 80)}`)
    .join("; ");
}
const SPLICE = /splice|junction|jonction|connection point|connexion|abzweig|verbindungspunkt/i;
/** wire splices / connection points: drawn like components, but not worth listing */
export const isSplice = (d: ElementDef | undefined) => !!d && (SPLICE.test(d.name) || SPLICE.test(d.category ?? ""));

/**
 * A component's name for people: its reference; a contact or other part without one is named after
 * the device it is linked to ("→K1"); else the symbol.
 */
export function refOf(doc: Doc, x: { e: ElemInst; def?: ElementDef }): string {
  const l = (x.e.info.label ?? "").trim();
  if (l) return l;
  for (const id of x.e.links ?? []) {
    for (const p of doc.pages) {
      const o = p.elements.find((q) => q.id === id);
      if (o?.info.label?.trim()) return `→${o.info.label.trim()}`;
    }
  }
  return x.def ? `(${x.def.name})` : "?";
}
const symbolText = (d: ElementDef | undefined) => (d ? `${d.name}${d.category ? ` [${d.category}]` : ""}` : "?");
const cell = (doc: Doc, page: Page, e: ElemInst) => gridRef(doc, page, { x: e.x, y: e.y });

export function overviewText(doc: Doc): string {
  const pages = sheets(doc);
  const els = allElements(doc);
  const wires = allWires(doc);
  const prefixes = new Map<string, number>();
  for (const x of els) {
    const m = /^([A-Za-z]+)/.exec(x.e.info.label ?? "");
    if (m && !x.e.info.label!.includes(":")) prefixes.set(m[1], (prefixes.get(m[1]) ?? 0) + 1);
  }
  const wn = wireNumberingOf(doc);
  const std = wiringOf(doc).standard;
  const lines = [
    `Drawing "${doc.meta.title}" — wiring standard ${STANDARDS[std]?.name ?? std}; wire numbering ${wn.preset} (${wn.format})`,
    `Reference numbering: ${doc.numbering.rules.map((r) => `${r.match}→${r.prefix || "(symbol prefix)"} ${r.format} per ${r.scope}`).join("; ") || "symbol prefixes"}${doc.numbering.autoOnPlace ? "; references are given when placing" : ""}`,
    "",
    "Pages:",
    ...pages.map((p, i) => `  ${i + 1} "${p.title}"${p.kind && p.kind !== "drawing" ? ` (${p.kind})` : ""} — ${p.elements.filter((e) => !isJunctionDef(doc.defs[e.defId])).length} components, ${p.wires.length} wires; sheet grid ${p.border.cols} columns × ${p.border.rows} rows`),
    "",
    `Components: ${els.length} (${[...prefixes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(", ") || "none"})`,
    `Wires: ${wires.length} (${wires.filter((x) => x.w.label).length} numbered, ${wires.filter((x) => x.w.a.k === "free" || x.w.b.k === "free").length} with a free end)`,
  ];
  if (doc.cables?.length) lines.push(`Cables: ${doc.cables.map((c) => `${c.tag} ${c.cores.length} cores${c.section ? " " + c.section : ""}`).join(", ")}`);
  const strips = collectStrips(doc).filter((s) => s.rows.length);
  if (strips.length) lines.push(`Terminal strips: ${strips.map((s) => `${s.tag || "(terminals without a strip)"}: ${s.rows.length}`).join(", ")}`);
  const props = Object.entries(doc.meta.props ?? {}).filter(([, v]) => v);
  if (props.length) lines.push(`Project properties: ${props.slice(0, 20).map(([k, v]) => `${k}=${v}`).join("; ")}`);
  return lines.join("\n");
}

export function componentsText(doc: Doc, o: { page?: Page; query?: string; limit?: number } = {}): string {
  const q = o.query?.trim().toLowerCase();
  let list = allElements(doc).filter((x) => !o.page || x.page === o.page);
  const splices = list.filter((x) => !x.e.info.label && isSplice(x.def)).length;
  if (q) list = list.filter((x) => [refOf(doc, x), x.def?.name, x.def?.category, ...Object.values(x.e.info)].join(" ").toLowerCase().includes(q));
  else list = list.filter((x) => x.e.info.label || !isSplice(x.def));
  const limit = o.limit ?? 300;
  const head = "reference | page·cell | symbol [category] | data | pins | id";
  const byId = new Map(allElements(doc).map((x) => [x.e.id, x]));
  const mated = (x: Located) => {
    const o = x.e.mate ? byId.get(x.e.mate.id) : undefined;
    return o ? ` (mated ↔ ${refOf(doc, o)}${o.page !== x.page ? `@${sheetNo(doc, o.page)}` : ""})` : "";
  };
  const rows = list.slice(0, limit).map((x) => `${refOf(doc, x)}${x.e.refLocked ? " (locked)" : ""}${mated(x)} | ${sheetNo(doc, x.page)}·${cell(doc, x.page, x.e) || "?"} | ${symbolText(x.def)} | ${infoText(x.e) || "-"} | ${x.def?.pins.map((p) => pinLabel(p, x.def)).join(",") || "-"} | ${short(x.e.id)}`);
  return [`${list.length} component${list.length === 1 ? "" : "s"}${list.length > limit ? ` (first ${limit}; narrow with page or query)` : ""}${!q && splices ? `; ${splices} wire splices not listed` : ""}. "→K1" = a contact or part linked to device K1.`, head, ...rows].join("\n");
}

function endText(doc: Doc, page: Page, w: Wire, end: "a" | "b") {
  const e = w[end];
  if (e.k === "pin") {
    const el = page.elements.find((x) => x.id === e.el);
    const def = el ? doc.defs[el.defId] : undefined;
    if (!el) return "?";
    if (isSplice(def) && !el.info.label) return "splice";
    const pin = def?.pins.find((p) => p.id === e.pin);
    return `${refOf(doc, { e: el, def })}${pin ? `:${pinLabel(pin, def)}` : ""}`;
  }
  if (e.k === "junction") return "junction";
  return "FREE END";
}

export function wireLine(doc: Doc, page: Page, w: Wire) {
  const i = wireInfo(doc, w);
  const circ = [wirePot(w), wireUse(w)].filter(Boolean).join("/");
  return `${short(w.id)} | ${sheetNo(doc, page)} | ${w.label || "·"}${w.labelLocked ? " (locked)" : ""} | ${endText(doc, page, w, "a")} → ${endText(doc, page, w, "b")} | ${circ || "-"} | ${[i.color, i.section].filter(Boolean).join(" ") || "-"}${w.cable ? ` | cable ${w.cable}:${w.core ?? "?"}` : ""}`;
}

export function wiresText(doc: Doc, o: { page?: Page; query?: string; unnumbered?: boolean; limit?: number; points?: boolean } = {}): string {
  const q = o.query?.trim().toLowerCase();
  let list = allWires(doc).filter((x) => !o.page || x.page === o.page);
  if (o.unnumbered) list = list.filter((x) => !x.w.label);
  if (q) list = list.filter((x) => wireLine(doc, x.page, x.w).toLowerCase().includes(q));
  const limit = o.limit ?? 400;
  return [
    `${list.length} wire${list.length === 1 ? "" : "s"}${list.length > limit ? ` (first ${limit}; narrow with page or query)` : ""}`,
    `id | page | number | from → to | potential/use | colour section | cable${o.points ? " | path (x,y …)" : ""}`,
    ...list.slice(0, limit).map((x) => wireLine(doc, x.page, x.w) + (o.points ? ` | path ${x.w.pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ")}${x.w.pts.length > 2 ? ` (${x.w.pts.length - 2} bend${x.w.pts.length === 3 ? "" : "s"})` : ""}` : "")),
  ].join("\n");
}

/** one device (all its parts) with what every pin connects to */
export function componentText(doc: Doc, parts: Located[]): string {
  const idx = indexElements(doc);
  const spliceEl = (id: string) => {
    const x = idx.get(id);
    return !!x && !x.e.info.label && isSplice(x.def);
  };
  const { netOfPin } = projectNets(doc, idx);
  const out: string[] = [];
  for (const x of parts) {
    out.push(`${refOf(doc, x)} on page ${sheetNo(doc, x.page)} "${x.page.title}", cell ${cell(doc, x.page, x.e) || "?"} — ${symbolText(x.def)} ${short(x.e.id)}${x.e.refLocked ? " (reference locked)" : ""}`);
    out.push(`  at x=${x.e.x} y=${x.e.y}, rotation ${x.e.rot * 90}°${x.e.mirror ? ", mirrored" : ""}`);
    const info = Object.entries(x.e.info).filter(([k, v]) => !HIDDEN_INFO.has(k) && v);
    if (info.length) out.push(`  data: ${info.map(([k, v]) => `${k}=${v}`).join("; ")}`);
    const flags = [x.e.locked && "locked in place", x.e.hidden && "hidden", x.e.scale && x.e.scale !== 1 && `size ${Math.round(x.e.scale * 100)} %`].filter(Boolean);
    if (flags.length) out.push(`  ${flags.join(", ")}`);
    if (x.e.mate) {
      const o = idx.get(x.e.mate.id);
      out.push(`  mated with ${o ? `${refOf(doc, o)} on page ${sheetNo(doc, o.page)}` : "a missing component"} (this side ${x.e.mate.gender}; pins connect by number)`);
    }
    if (isReport(x.def)) {
      const ls = (x.e.links ?? []).map((id) => idx.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
      out.push(`  off-page arrow (${x.def!.linkType === "next_report" ? "going" : "coming"}): ${ls.length ? `linked to ${ls.map((o) => `${refOf(doc, o)}@${sheetNo(doc, o.page)}·${cell(doc, o.page, o.e) || "?"}`).join(", ")}` : "NOT LINKED — the conductor ends here"}`);
    }
    // where its texts sit (move_labels moves them)
    const labels = componentLabels(doc, x.page, x.e, docStyles(doc), approxMeasure);
    if (labels.length) {
      const word = { reference: "reference", description: "description", xref: "cross-reference", mate: "counterpart label" } as const;
      const kinds = [...new Set(labels.map((l) => l.kind))];
      out.push(`  labels: ${kinds.map((k) => { const b = labels.filter((l) => l.kind === k).map((l) => l.box); const x0 = Math.min(...b.map((r) => r.x)), y0 = Math.min(...b.map((r) => r.y)), x1 = Math.max(...b.map((r) => r.x + r.w)), y1 = Math.max(...b.map((r) => r.y + r.h)); return `${word[k]} ${Math.round(x0)},${Math.round(y0)}–${Math.round(x1)},${Math.round(y1)}`; }).join("; ")}`);
    }
    if (x.e.group) out.push(`  part of block "${x.e.group.name}" rev ${x.e.group.revision} (${x.e.group.mode})`);
    if (x.def?.source?.libraryElementId) out.push(`  symbol from the library: ${x.def.source.libraryElementId} rev ${x.def.source.revision ?? "?"}`);
    for (const pin of x.def?.pins ?? []) {
      const net = netOfPin.get(`p:${x.e.id}/${pin.id}`) ?? netOfPin.get(`${x.e.id}/${pin.id}`);
      const others = net
        ? net.pins
            .filter((p) => !(p.el === x.e.id && p.pin === pin.id) && !spliceEl(p.el))
            .map((p) => {
              const o = idx.get(p.el);
              const pd = o?.def?.pins.find((q) => q.id === p.pin);
              return `${o ? refOf(doc, o) : "?"}:${pd ? pinLabel(pd, o?.def) : "?"}${o && o.page !== x.page ? `@${sheetNo(doc, o.page)}` : ""}`;
            })
        : [];
      const ws = net?.wires.map((r) => {
        const page = doc.pages.find((p) => p.id === r.pageId);
        const w = page?.wires.find((q) => q.id === r.id);
        return w ? `${w.label || "·"} ${short(w.id)}` : "";
      }).filter(Boolean) ?? [];
      const at = toScene(x.e, pin);
      out.push(`  pin ${pinLabel(pin, x.def)}${pin.name && pin.name !== pin.number ? ` (${pin.name})` : ""} at (${fmt(at.x)}, ${fmt(at.y)}) facing ${ORIENT_NAME[rotOrient(pin.orient, x.e.rot, x.e.mirror)]}: ${others.length ? others.join(", ") : "not connected"}${ws.length ? ` — wires ${ws.slice(0, 8).join(", ")}${ws.length > 8 ? " …" : ""}` : ""}`);
    }
  }
  return out.join("\n");
}

/** every conductor (project-wide net) with its wires and the terminals it joins */
export function netlistText(doc: Doc, o: { page?: Page; limit?: number } = {}): string {
  const idx = indexElements(doc);
  const spliceEl = (id: string) => {
    const x = idx.get(id);
    return !!x && !x.e.info.label && isSplice(x.def);
  };
  const { nets } = projectNets(doc, idx);
  const list = o.page ? nets.filter((n) => n.wires.some((w) => w.pageId === o.page!.id) || n.pins.some((p) => p.pageId === o.page!.id)) : nets;
  const limit = o.limit ?? 600;
  const lines = [`${list.length} conductor${list.length === 1 ? "" : "s"} (nets, followed through junctions, terminals, folio reports and mated connectors)${list.length > limit ? ` — first ${limit}` : ""}`, "net | wires (number colour section id) | terminals joined (REF:pin@page)"];
  for (const net of list.slice(0, limit)) {
    const ws = net.wires.map((r) => {
      const page = doc.pages.find((p) => p.id === r.pageId)!;
      const w = page.wires.find((q) => q.id === r.id)!;
      const i = wireInfo(doc, w);
      return `${w.label || "·"}${[wirePot(w), wireUse(w)].filter(Boolean).length ? ` ${[wirePot(w), wireUse(w)].filter(Boolean).join("/")}` : ""}${i.color ? ` ${i.color}` : ""}${i.section ? ` ${i.section}` : ""} ${short(w.id)}${w.a.k === "free" || w.b.k === "free" ? " FREE-END" : ""}`;
    });
    const pins = net.pins.filter((p) => !spliceEl(p.el)).map((p) => {
      const x = idx.get(p.el);
      const pd = x?.def?.pins.find((q) => q.id === p.pin);
      return `${x ? refOf(doc, x) : "?"}:${pd ? pinLabel(pd, x?.def) : "?"}@${x ? sheetNo(doc, x.page) : "?"}`;
    });
    lines.push(`${net.id} | ${ws.join(", ") || "-"} | ${pins.join(" ") || "-"}`);
  }
  return lines.join("\n");
}

/** rule checks: electrical (ERC) and drawing validation */
export function checksText(doc: Doc): { text: string; errors: number; warnings: number } {
  const idx = indexElements(doc);
  const wireAt = new Map(allWires(doc).map((x) => [x.w.id, x]));
  const name = (id: string) => {
    const x = idx.get(id);
    if (x) return `${refOf(doc, x)}@${sheetNo(doc, x.page)}·${cell(doc, x.page, x.e) || "?"}`;
    const w = wireAt.get(id);
    if (w) return `wire ${w.w.label || "·"} ${short(id)}`;
    return short(id);
  };
  const erc = checkElectrical(doc);
  const val = validateDoc(doc);
  const rows = [
    ...erc.map((f) => ({ level: f.level, text: `[${f.category}] ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ""}`, ids: f.ids })),
    ...val.map((i) => ({ level: i.level, text: `[drawing] ${i.message}`, ids: i.ids })),
    // drawn at a size that puts the pins off the grid: wires to them cannot be straight
    ...sheets(doc).flatMap((p) =>
      offGridComponents(doc, p).map((x) => {
        const e = p.elements.find((q) => q.id === x.id)!;
        const ok = gridFriendlyScales(doc, e);
        return { level: "info" as const, text: `[layout] drawn at ${Math.round(x.scale * 100)} %, its pins are off the grid — wires to it bend${ok.length ? `; on the grid at ${ok.slice(0, 5).join(", ")} %` : ""} (straighten_wires fixes size and alignment)`, ids: [x.id] };
      }),
    ),
  ];
  const order = { error: 0, warning: 1, info: 2 } as const;
  rows.sort((a, b) => order[a.level] - order[b.level]);
  const errors = rows.filter((r) => r.level === "error").length;
  const warnings = rows.filter((r) => r.level === "warning").length;
  const text = [
    `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${rows.length - errors - warnings} note${rows.length - errors - warnings === 1 ? "" : "s"}`,
    ...rows.slice(0, 400).map((r) => `${r.level.toUpperCase()} ${r.text}${r.ids.length ? ` — ${r.ids.slice(0, 6).map(name).join(", ")}${r.ids.length > 6 ? " …" : ""}` : ""}`),
    ...(rows.length > 400 ? [`… ${rows.length - 400} more`] : []),
  ].join("\n");
  return { text, errors, warnings };
}

const ORIENT_NAME = { n: "up", e: "right", s: "down", w: "left" } as const;
const fmt = (v: number) => String(Math.round(v * 10) / 10);

export { pinLabel, toScene };
