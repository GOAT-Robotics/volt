/**
 * Changes an AI assistant can make to a drawing. Each function changes the document it is given
 * (an immer draft on the server) the way the editor does, and returns a short report. Errors the
 * assistant can act on are AddressError / EditError. No server dependencies (unit tested).
 */
import type { Doc, ElementDef, Page, Pt, Wire, WirePot, WireUse } from "@/core/model";
import { addWire, applyAutoConnections, deleteSelection, findAutoConnections, getPage, mkSel, moveSelection, newElement, pinOrientScene, cleanupJunctions } from "@/core/ops";
import { orthoRoute } from "@/core/wires";
import { toScene } from "@/core/geometry";
import { planRenumber, duplicateRefs, type RefChange } from "@/core/numbering";
import { applyRefChanges, planCloseGaps } from "@/core/impact";
import { applyWireNumbers, planWireNumbers } from "@/core/wirenumber";
import { WIRE_POTS, WIRE_USES } from "@/core/wiring";
import { isTerminalDef } from "@/core/terminals";
import { autoLinkReports } from "@/core/reports";
import { AddressError, findComponent, findComponents, findPin, sheetNo, short, type Located, pinLabel } from "./doc";

export class EditError extends Error {}

const isReport = (d: ElementDef | undefined) => d?.linkType === "next_report" || d?.linkType === "previous_report";

/* ------------------------------------------------------------------ */
/* Components                                                           */
/* ------------------------------------------------------------------ */

/** the editor's info keys for the friendly field names */
export const INFO_FIELDS = { description: "description", rating: "rating", part_number: "manufacturer_reference", manufacturer: "manufacturer", supplier: "supplier", location: "location", function: "function", comment: "comment", quantity: "quantity" } as const;
export type InfoField = keyof typeof INFO_FIELDS;

/**
 * Rename a component. Every part of the device (contacts, other representations, other sheets)
 * carries the same reference and is renamed with it — as in the editor. The new reference is
 * locked so automatic renumbering keeps it. Off-page arrows link to arrows with the same name.
 */
export function renameComponent(doc: Doc, ref: string, to: string): string {
  const next = to.trim();
  if (!next) throw new EditError("The new reference is empty");
  const parts = findComponents(doc, ref);
  const first = parts[0];
  const old = (first.e.info.label ?? "").trim();
  const report = isReport(first.def);
  const targets = report || ref.includes("@") || ref.startsWith("#") ? parts : parts.filter((x) => !isReport(x.def));
  const ids = new Set(targets.map((x) => x.e.id));
  const clash = !report && next !== old && doc.pages.some((p) => p.elements.some((x) => (x.info.label ?? "").trim() === next && !ids.has(x.id) && !isReport(doc.defs[x.defId]) && !(isTerminalDef(first.def) && isTerminalDef(doc.defs[x.defId]))));
  if (clash) throw new EditError(`${next} is already used by another component — choose another reference or rename that one first`);
  for (const p of doc.pages) for (const e of p.elements) if (ids.has(e.id)) {
    e.info.label = next;
    if (e.id === first.e.id) e.refLocked = true;
  }
  let linked = 0;
  if (report) linked = autoLinkReports(doc, next);
  return `Renamed ${old || "(no reference)"} → ${next} on ${targets.length} part${targets.length === 1 ? "" : "s"}${targets.length > 1 ? ` (${targets.map((x) => `page ${sheetNo(doc, x.page)}`).join(", ")})` : ""}; reference locked${linked ? `; linked ${linked} off-page arrow${linked === 1 ? "" : "s"}` : ""}`;
}

/** Set component data (name, rating, part number …). Empty string clears a field. */
export function setComponentData(doc: Doc, ref: string, fields: Partial<Record<InfoField, string>>, extra: Record<string, string> = {}, opts: { allParts?: boolean; lockReference?: boolean } = {}): string {
  const parts = opts.allParts ? findComponents(doc, ref) : [findOneForData(doc, ref)];
  const set: Record<string, string> = { ...extra };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) set[INFO_FIELDS[k as InfoField]] = v;
  if ("label" in set) throw new EditError("Use rename_component to change a reference");
  const keys = Object.keys(set);
  for (const x of parts) {
    const e = getPage(doc, x.page.id).elements.find((q) => q.id === x.e.id)!;
    for (const k of keys) {
      const v = set[k].trim();
      if (v) e.info[k] = v;
      else delete e.info[k];
    }
    if (opts.lockReference !== undefined) e.refLocked = opts.lockReference;
  }
  return `${parts.map((x) => `${x.e.info.label || short(x.e.id)}@${sheetNo(doc, x.page)}`).join(", ")}: ${keys.map((k) => `${k}=${set[k].trim() || "(cleared)"}`).join("; ")}${opts.lockReference !== undefined ? `; reference ${opts.lockReference ? "locked" : "unlocked"}` : ""}`;
}

/** a device's data belongs on its main part (the coil, not the contacts): the one with most data, else the first */
function findOneForData(doc: Doc, ref: string): Located {
  const parts = findComponents(doc, ref);
  if (parts.length === 1) return parts[0];
  const main = parts.find((x) => x.def?.linkType === "master") ?? parts.find((x) => x.def?.linkType === "simple" || !x.def?.linkType);
  if (main && parts.filter((x) => x.def?.linkType === main.def?.linkType).length === 1) return main;
  return findComponent(doc, ref); // ambiguous: asks which
}

/**
 * Renumber references. close_gaps: K1, K2, K4 → K1, K2, K3 (device-aware, locked references kept).
 * by_rules: number everything again by the project's numbering rules, sheet by sheet, left to
 * right; the parts of one device keep sharing their reference.
 */
export function planReferences(doc: Doc, o: { mode: "close_gaps" | "by_rules"; pageIds?: string[]; prefixes?: string[]; onlyUnnamed?: boolean }): RefChange[] {
  if (o.mode === "close_gaps") return planCloseGaps(doc, o.prefixes?.length ? o.prefixes : undefined);
  // the parts of a device share one reference: number the first part, the others follow it
  const groups = new Map<string, { pageId: string; elId: string }[]>();
  const order = [...doc.pages].sort((a, b) => a.order - b.order);
  for (const p of order) for (const e of p.elements) {
    const l = (e.info.label ?? "").trim();
    const def = doc.defs[e.defId];
    if (!l || isReport(def) || isTerminalDef(def)) continue;
    const g = groups.get(l) ?? [];
    g.push({ pageId: p.id, elId: e.id });
    groups.set(l, g);
  }
  const followers = new Set<string>();
  for (const g of groups.values()) for (const x of g.slice(1)) followers.add(x.elId);
  const view: Doc = { ...doc, pages: doc.pages.map((p) => ({ ...p, elements: p.elements.filter((e) => !followers.has(e.id)) })) };
  let plan = planRenumber(view, o.pageIds?.length ? o.pageIds : "all", !!o.onlyUnnamed);
  if (o.prefixes?.length) plan = plan.filter((c) => o.prefixes!.some((p) => c.from.startsWith(p) || c.to.startsWith(p)));
  const out: RefChange[] = [...plan];
  for (const c of plan) {
    const g = c.from ? groups.get(c.from) : undefined;
    if (g && g.length > 1) for (const x of g.slice(1)) out.push({ pageId: x.pageId, elId: x.elId, from: c.from, to: c.to });
  }
  return out;
}
export function applyReferences(doc: Doc, ch: RefChange[]) {
  applyRefChanges(doc, ch);
}
export function refChangesText(ch: RefChange[]) {
  const seen = new Set<string>();
  const uniq = ch.filter((c) => (seen.has(c.from + "→" + c.to) ? false : (seen.add(c.from + "→" + c.to), true)));
  return uniq.length ? uniq.map((c) => `${c.from || "(none)"} → ${c.to}`).join(", ") : "nothing to change";
}
export function duplicatesText(doc: Doc) {
  const d = duplicateRefs(doc);
  return [...d.keys()];
}

/** Place a component from a symbol definition at a position; free wire ends on its pins attach. */
export function placeComponent(doc: Doc, page: Page, def: ElementDef, at: Pt, o: { rotation?: number; reference?: string; data?: Record<string, string> } = {}): string {
  const pg = getPage(doc, page.id);
  const rot = (((Math.round((o.rotation ?? 0) / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  const e = newElement(doc, pg, def, at, rot);
  if (o.reference?.trim()) {
    const ref = o.reference.trim();
    if (doc.pages.some((p) => p.elements.some((x) => x.id !== e.id && (x.info.label ?? "").trim() === ref)) && !isTerminalDef(def)) throw new EditError(`${ref} is already used — leave the reference empty to get the next free one, or rename the other component first`);
    e.info.label = ref;
    e.refLocked = true;
  }
  for (const [k, v] of Object.entries(o.data ?? {})) if (v.trim()) e.info[k] = v.trim();
  const auto = findAutoConnections(doc, pg, [e.id]);
  applyAutoConnections(pg, auto);
  return `Placed ${e.info.label || def.name} (${def.name}) on page ${sheetNo(doc, page)} at x=${at.x} y=${at.y}${rot ? `, rotated ${rot * 90}°` : ""} ${short(e.id)}; pins ${def.pins.map((p) => pinLabel(p, def)).join(", ") || "none"}${auto.length ? `; ${auto.length} free wire end${auto.length === 1 ? "" : "s"} attached` : ""}`;
}

export function moveComponent(doc: Doc, ref: string, to: { at?: Pt; dx?: number; dy?: number }): string {
  const x = findComponent(doc, ref);
  const pg = getPage(doc, x.page.id);
  const d = to.at ? { x: to.at.x - x.e.x, y: to.at.y - x.e.y } : { x: to.dx ?? 0, y: to.dy ?? 0 };
  if (x.e.locked) throw new EditError(`${x.e.info.label} is locked in place`);
  moveSelection(doc, pg, mkSel({ elements: [x.e.id] }), d);
  const auto = findAutoConnections(doc, pg, [x.e.id]);
  applyAutoConnections(pg, auto);
  return `Moved ${x.e.info.label || short(x.e.id)} by (${d.x}, ${d.y}) to x=${x.e.x + d.x} y=${x.e.y + d.y}; its wires follow${auto.length ? `; ${auto.length} free wire end${auto.length === 1 ? "" : "s"} attached` : ""}`;
}

/** Delete a component; its wires stay with free ends (as in the editor). */
export function deleteComponent(doc: Doc, ref: string, o: { closeGaps?: boolean } = {}): string {
  const x = findComponent(doc, ref);
  const pg = getPage(doc, x.page.id);
  if (x.e.locked) throw new EditError(`${x.e.info.label} is locked`);
  const label = (x.e.info.label ?? "").trim();
  deleteSelection(doc, pg, mkSel({ elements: [x.e.id] }));
  let gaps = "";
  if (o.closeGaps && label && !doc.pages.some((p) => p.elements.some((e) => (e.info.label ?? "").trim() === label))) {
    const m = /^(.*?)(\d+)$/.exec(label);
    if (m) {
      const ch = planCloseGaps(doc, [m[1]]);
      applyRefChanges(doc, ch);
      if (ch.length) gaps = `; closed the gap: ${refChangesText(ch)}`;
    }
  }
  return `Deleted ${label || short(x.e.id)} (${x.def?.name ?? "?"}) from page ${sheetNo(doc, x.page)}; its wires keep free ends${gaps}`;
}

/* ------------------------------------------------------------------ */
/* Wires                                                                */
/* ------------------------------------------------------------------ */

/** Draw a wire between two pins on the same page (routed orthogonally, like Connect pins). */
export function connectPins(doc: Doc, from: string, to: string, o: { number?: string } = {}): { text: string; wireId: string } {
  const a = findPin(doc, from);
  const b = findPin(doc, to);
  if (a.page.id !== b.page.id) throw new EditError(`${from} is on page ${sheetNo(doc, a.page)} and ${to} on page ${sheetNo(doc, b.page)}: a wire joins pins on one sheet — use off-page arrows (folio reports) with the same name on both sheets`);
  if (a.e.id === b.e.id && a.pin.id === b.pin.id) throw new EditError("Both ends are the same pin");
  const pg = getPage(doc, a.page.id);
  const p1 = toScene(a.e, a.pin), p2 = toScene(b.e, b.pin);
  const pts = orthoRoute(p1, p2, pinOrientScene(a.e, a.def!, a.pin.id), pinOrientScene(b.e, b.def!, b.pin.id));
  const w = addWire(pg, { k: "pin", el: a.e.id, pin: a.pin.id, p: p1 }, { k: "pin", el: b.e.id, pin: b.pin.id, p: p2 }, pts, o.number?.trim() ? { label: o.number.trim(), labelLocked: true } : {});
  if (!w) throw new EditError("No wire was drawn (the pins are at the same place?)");
  return { text: `Connected ${a.e.info.label}:${pinLabel(a.pin, a.def)} → ${b.e.info.label}:${pinLabel(b.pin, b.def)} on page ${sheetNo(doc, a.page)} ${short(w.id)}${w.label ? `, number ${w.label}` : ""}`, wireId: w.id };
}

export type WirePatch = { number?: string; numberLocked?: boolean; potential?: string; use?: string; colour?: string; section?: string; cable?: string; core?: string };

/** Conductor data for one or more wires. Empty string clears a field; a typed number is locked. */
export function setWires(doc: Doc, wireIds: string[], patch: WirePatch): string {
  const pot = patch.potential?.trim();
  if (pot && !WIRE_POTS.some((x) => x.id === pot)) throw new EditError(`potential must be one of ${WIRE_POTS.map((x) => x.id).join(", ")}`);
  const use = patch.use?.trim();
  if (use && !WIRE_USES.some((x) => x.id === use)) throw new EditError(`use must be one of ${WIRE_USES.map((x) => x.id).join(", ")}`);
  if (patch.number?.trim() && wireIds.length > 1) throw new EditError("Give a wire number to one wire at a time (or run number_wires)");
  let n = 0;
  for (const p of doc.pages)
    for (const w of p.wires) {
      if (!wireIds.includes(w.id)) continue;
      n++;
      const set = <K extends keyof Wire>(k: K, v: string | undefined, conv: (s: string) => Wire[K] = (s) => s as Wire[K]) => {
        if (v === undefined) return;
        if (v.trim()) w[k] = conv(v.trim());
        else delete w[k];
      };
      if (patch.number !== undefined) {
        set("label", patch.number);
        if (patch.number.trim()) w.labelLocked = true;
        else delete w.labelLocked;
      }
      if (patch.numberLocked !== undefined) w.labelLocked = patch.numberLocked || undefined;
      set("pot", patch.potential, (s) => s as WirePot);
      set("use", patch.use, (s) => s as WireUse);
      if (patch.potential !== undefined || patch.use !== undefined) delete w.fn;
      set("insulation", patch.colour);
      set("section", patch.section);
      set("cable", patch.cable);
      set("core", patch.core);
    }
  if (!n) throw new EditError("No such wires");
  const what = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v === "" ? "(cleared)" : v}`).join("; ");
  return `${n} wire${n === 1 ? "" : "s"}: ${what}`;
}

export function deleteWires(doc: Doc, wireIds: string[]): string {
  let n = 0;
  for (const p of doc.pages) {
    const before = p.wires.length;
    p.wires = p.wires.filter((w) => !wireIds.includes(w.id));
    if (p.wires.length !== before) {
      n += before - p.wires.length;
      cleanupJunctions(p);
    }
  }
  if (!n) throw new EditError("No such wires");
  return `Deleted ${n} wire${n === 1 ? "" : "s"}`;
}

/** Automatic wire numbering (as Wire numbering… in the editor). */
export function numberWires(doc: Doc, mode: "new" | "all", pageIds?: string[], apply = true) {
  const plan = planWireNumbers(doc, { mode, pageIds });
  if (apply) applyWireNumbers(doc, plan);
  const ch = plan.changes.filter((c) => c.from !== c.to);
  const text = [
    `${plan.stats.circuits} circuits, ${plan.stats.wires} wires: ${ch.length} number${ch.length === 1 ? "" : "s"} ${apply ? "changed" : "would change"}, ${plan.stats.locked} locked kept, ${plan.stats.unclassified} unclassified`,
    ...ch.slice(0, 200).map((c) => `${short(c.wireId)} ${c.from || "·"} → ${c.to} (${c.cls}, ${c.why})`),
    ...(ch.length > 200 ? [`… ${ch.length - 200} more`] : []),
    ...plan.circuits.filter((c) => c.conflict).slice(0, 20).map((c) => `CONFLICT circuit ${c.label}: ${c.conflict}`),
  ].join("\n");
  return { text, changed: ch.length };
}

export { AddressError };
