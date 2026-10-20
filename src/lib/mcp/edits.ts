/**
 * Changes an AI assistant can make to a drawing. Each function changes the document it is given
 * (an immer draft on the server) the way the editor does, and returns a short report. Errors the
 * assistant can act on are AddressError / EditError. No server dependencies (unit tested).
 */
import type { ComponentFrame, ComponentInfoFlags, Doc, ElemInst, ElementDef, InfoPlacement, LineStyle, Orient, Page, PinClass, Pt, TextStyle, Wire, WirePot, WireUse } from "@/core/model";
import { COMPONENT_INFO, PIN_CLASSES } from "@/core/model";
import { addWire, applyAutoConnections, copySelection, deleteSelection, findAutoConnections, getPage, mirrorSelection, mkSel, moveSelection, newElement, pasteClip, pinOrientScene, cleanupJunctions, reattachEnd, rotateSelection, scaleElements, type EndTarget } from "@/core/ops";
import { orthoRoute, nearestSegment, simplify } from "@/core/wires";
import { eqPt, toScene } from "@/core/geometry";
import { clearMate, guessGender, isConnector, matedPinPairs, setMate, type Gender } from "@/core/mating";
import { isReportDef, linkReports, unlinkReport, looksLikeArrow } from "@/core/reports";
import { replaceSymbol as replaceSymbolCore } from "@/core/replace";
import { convertShapesToWires, isOpenPath } from "@/core/shapes";
import { despike, gridFriendlyScales, offGridComponents, straightenWires } from "@/core/straighten";
import { computeNets } from "@/core/topology";
import { wireNumberingOf } from "@/core/wirenumber";
import { planRenumber, duplicateRefs, type RefChange } from "@/core/numbering";
import { applyRefChanges, planCloseGaps } from "@/core/impact";
import { applyWireNumbers, planWireNumbers } from "@/core/wirenumber";
import { WIRE_POTS, WIRE_USES, wirePot, wireUse, assignCores, makeCores, nextCableTag, cableDesignation, type CoreScheme } from "@/core/wiring";
import { isTerminalDef } from "@/core/terminals";
import { autoLinkReports } from "@/core/reports";
import { AddressError, findComponent, findComponents, findPage, findPin, findWires, positionOf, refOf, sheetNo, short, type Located, pinLabel } from "./doc";

export class EditError extends Error {}

const isReport = (d: ElementDef | undefined) => d?.linkType === "next_report" || d?.linkType === "previous_report";

/* ------------------------------------------------------------------ */
/* Components                                                           */
/* ------------------------------------------------------------------ */

/** the editor's info keys for the friendly field names */
export const INFO_FIELDS = { description: "description", rating: "rating", part_number: "manufacturer_reference", manufacturer: "manufacturer", supplier: "supplier", location: "location", function: "function", comment: "comment", quantity: "quantity", unit: "unity", designation: "designation" } as const;
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
export function placeComponent(doc: Doc, page: Page, def: ElementDef, at: Pt, o: { rotation?: number; mirrored?: boolean; scale?: number; reference?: string; data?: Record<string, string> } = {}): string {
  const pg = getPage(doc, page.id);
  const rot = (((Math.round((o.rotation ?? 0) / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  const e = newElement(doc, pg, def, at, rot, !!o.mirrored);
  if (o.scale && o.scale !== 100) e.scale = Math.min(5, Math.max(0.2, Math.round(o.scale) / 100));
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

export type WirePatch = {
  number?: string;
  numberLocked?: boolean;
  potential?: string;
  use?: string;
  colour?: string;
  section?: string;
  cable?: string;
  core?: string;
  /** supply (wire class) by letter, id or name; "PE" = protective earth; "" = detect */
  supply?: string;
  /** names written at the start / end of the wire (wire markers); "" = automatic */
  endStart?: string;
  endEnd?: string;
  /** where the number sits along the wire, 0.05–0.95; null = automatic */
  labelPos?: number | null;
  bus?: boolean;
  /** line drawn in another colour / width / dash; null = project style */
  line?: Partial<LineStyle> | null;
};

/** Conductor data for one or more wires. Empty string clears a field; a typed number is locked. */
export function setWires(doc: Doc, wireIds: string[], patch: WirePatch, o: { applyToNet?: boolean } = {}): string {
  const pot = patch.potential?.trim();
  if (pot && !WIRE_POTS.some((x) => x.id === pot)) throw new EditError(`potential must be one of ${WIRE_POTS.map((x) => x.id).join(", ")}`);
  const use = patch.use?.trim();
  if (use && !WIRE_USES.some((x) => x.id === use)) throw new EditError(`use must be one of ${WIRE_USES.map((x) => x.id).join(", ")}`);
  if (patch.number?.trim() && wireIds.length > 1) throw new EditError("Give a wire number to one wire at a time (or run number_wires)");
  let vclass: string | undefined | null = null;
  if (patch.supply !== undefined) {
    const q = patch.supply.trim();
    if (!q) vclass = undefined;
    else {
      const cfg = wireNumberingOf(doc);
      const k = q.toLowerCase();
      if (k === "pe" || k === cfg.peLetter.toLowerCase() || k === "__pe") vclass = "__pe";
      else {
        const c = cfg.classes.find((x) => x.id.toLowerCase() === k) ?? cfg.classes.find((x) => x.letter.toLowerCase() === k) ?? cfg.classes.find((x) => x.name.toLowerCase() === k);
        if (!c) throw new EditError(`No supply "${q}". Supplies: ${cfg.classes.map((x) => `${x.letter} = ${x.name}`).join(", ")}, PE — add one with update_settings wire_numbering.classes`);
        vclass = c.id;
      }
    }
  }
  if (patch.labelPos !== undefined && patch.labelPos !== null && !(patch.labelPos >= 0 && patch.labelPos <= 1)) throw new EditError("label_position is a fraction of the wire length, 0.05–0.95");
  let n = 0;
  const touched: { w: Wire; page: Page }[] = [];
  for (const p of doc.pages)
    for (const w of p.wires) {
      if (!wireIds.includes(w.id)) continue;
      n++;
      touched.push({ w, page: p });
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
      if (vclass !== null) {
        if (vclass) w.vclass = vclass;
        else delete w.vclass;
      }
      if (patch.endStart !== undefined || patch.endEnd !== undefined) {
        const e = { ...(w.endLabels ?? {}) };
        if (patch.endStart !== undefined) e.a = patch.endStart.trim() || undefined;
        if (patch.endEnd !== undefined) e.b = patch.endEnd.trim() || undefined;
        if (e.a || e.b) w.endLabels = e;
        else delete w.endLabels;
      }
      if (patch.labelPos !== undefined) {
        if (patch.labelPos === null) delete w.labelPos;
        else w.labelPos = Math.min(0.95, Math.max(0.05, patch.labelPos));
      }
      if (patch.bus !== undefined) {
        if (patch.bus) w.bus = true;
        else delete w.bus;
      }
      if (patch.line !== undefined) {
        if (patch.line === null) delete w.override;
        else w.override = { ...(w.override ?? {}), ...patch.line };
      }
    }
  if (!n) throw new EditError("No such wires");
  let net = 0;
  if (o.applyToNet) {
    for (const { w, page } of touched) {
      const nets = computeNets(page, doc);
      const mine = nets.find((x) => x.wires.includes(w.id));
      for (const other of page.wires) {
        if (!mine?.wires.includes(other.id) || other.id === w.id || wireIds.includes(other.id)) continue;
        other.pot = wirePot(w);
        other.use = wireUse(w);
        delete other.fn;
        for (const k of ["vclass", "insulation", "section"] as const) {
          if (w[k] !== undefined) other[k] = w[k];
          else delete other[k];
        }
        net++;
      }
    }
  }
  const what = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v === "" || v === null ? "(cleared)" : typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("; ");
  return `${n} wire${n === 1 ? "" : "s"}: ${what}${o.applyToNet ? `; potential, use, supply, colour and section copied to ${net} other wire${net === 1 ? "" : "s"} of the same net` : ""}`;
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


/* ------------------------------------------------------------------ */
/* Mated connectors                                                     */
/* ------------------------------------------------------------------ */

/** the editable element of a located part (the draft object, not a copy) */
const draftOf = (doc: Doc, x: Located): ElemInst => getPage(doc, x.page.id).elements.find((e) => e.id === x.e.id)!;

/**
 * Mate a plug with its socket (or any two parts that connect pin to pin): pins pair up by number
 * (then name, then order), nets run through the pair and the references cross-link. Earlier
 * mates of both are cleared. `mateRef` empty = unmate.
 */
export function mateConnectors(doc: Doc, ref: string, mateRef: string | null, o: { gender?: Gender; label?: "auto" | "show" | "hide" } = {}): string {
  const a = findComponent(doc, ref);
  const nameA = refOf(doc, a);
  if (!mateRef?.trim()) {
    if (!a.e.mate) return `${nameA} is not mated`;
    const was = findById(doc, a.e.mate.id);
    clearMate(doc, a.e.id);
    return `Unmated ${nameA}${was ? ` from ${refOf(doc, was)}` : ""}`;
  }
  const b = findComponent(doc, mateRef);
  if (a.e.id === b.e.id) throw new EditError("A connector cannot mate with itself");
  if (!a.def?.pins.length || !b.def?.pins.length) throw new EditError(`${!a.def?.pins.length ? nameA : refOf(doc, b)} has no pins to mate`);
  const ga = guessGender(a.def), gb = guessGender(b.def);
  const gender: Gender = o.gender ?? a.e.mate?.gender ?? ga ?? (gb === "male" ? "female" : "male");
  const before = [a.e.mate && a.e.mate.id !== b.e.id ? findById(doc, a.e.mate.id) : null, b.e.mate && b.e.mate.id !== a.e.id ? findById(doc, b.e.mate.id) : null].filter((x): x is Located => !!x);
  setMate(doc, a.e.id, b.e.id, gender);
  const ea = draftOf(doc, a), eb = draftOf(doc, b);
  if (o.label) for (const e of [ea, eb]) if (e.mate) e.mate.label = o.label === "auto" ? undefined : o.label;
  const male = gender === "male" ? a : b, female = gender === "male" ? b : a;
  const pairs = matedPinPairs(male.def!, female.def!);
  const pinName = (def: ElementDef, id: string) => {
    const p = def.pins.find((q) => q.id === id);
    return p ? pinLabel(p, def) : "?";
  };
  const unpairedM = male.def!.pins.length - pairs.length, unpairedF = female.def!.pins.length - pairs.length;
  const notes: string[] = [];
  if (o.gender && ga && ga !== o.gender) notes.push(`${nameA}'s symbol looks ${ga}, set as ${o.gender}`);
  if (ga && gb && ga === gb && !o.gender) notes.push(`both symbols look ${ga} — check the genders`);
  if (!isConnector(a.def) || !isConnector(b.def)) notes.push(`${[!isConnector(a.def) ? nameA : "", !isConnector(b.def) ? refOf(doc, b) : ""].filter(Boolean).join(" and ")} is not drawn as a connector symbol (mated anyway)`);
  if (unpairedM || unpairedF) notes.push(`${unpairedM + unpairedF} pin${unpairedM + unpairedF === 1 ? "" : "s"} without a partner (${refOf(doc, male)} ${male.def!.pins.length} pins, ${refOf(doc, female)} ${female.def!.pins.length} pins)`);
  return [
    `Mated ${refOf(doc, male)} (male, page ${sheetNo(doc, male.page)}) ↔ ${refOf(doc, female)} (female, page ${sheetNo(doc, female.page)}): ${pairs.length} pin${pairs.length === 1 ? "" : "s"} connected`,
    pairs.length ? `  pins: ${pairs.slice(0, 60).map((p) => `${pinName(male.def!, p.a)}↔${pinName(female.def!, p.b)}`).join(", ")}${pairs.length > 60 ? " …" : ""}` : "",
    before.length ? `  no longer mated: ${before.map((x) => refOf(doc, x)).join(", ")}` : "",
    notes.length ? `  note: ${notes.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function findById(doc: Doc, id: string): Located | null {
  for (const page of doc.pages) {
    const e = page.elements.find((x) => x.id === id);
    if (e) return { e, page, def: doc.defs[e.defId] };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Arranging and styling components                                     */
/* ------------------------------------------------------------------ */

/** every part each address means, without duplicates */
export function partsOf(doc: Doc, refs: string[]): Located[] {
  const out = new Map<string, Located>();
  for (const r of refs) for (const x of findComponents(doc, r)) out.set(x.e.id, x);
  if (!out.size) throw new EditError("No components given");
  return [...out.values()];
}

export type Arrange = {
  /** quarter turns clockwise: 90, 180, 270 (−90 = counter-clockwise) */
  rotate?: number;
  /** absolute rotation 0 / 90 / 180 / 270 */
  rotation?: number;
  mirrored?: boolean;
  /** size in percent (100 = normal) */
  scale?: number;
  locked?: boolean;
  hidden?: boolean;
  align?: "left" | "center" | "right" | "top" | "middle" | "bottom";
  distribute?: "horizontal" | "vertical";
};

/** Rotate (each about its own origin), mirror, resize, lock, hide, align and distribute components; wires follow. */
export function arrangeComponents(doc: Doc, refs: string[], a: Arrange): string {
  const parts = partsOf(doc, refs);
  const done: string[] = [];
  const turn = (deg: number) => {
    const q = Math.round(deg / 90);
    if (q * 90 !== Math.round(deg)) throw new EditError("Rotate in steps of 90°");
    return ((q % 4) + 4) % 4;
  };
  if (a.locked === false) for (const x of parts) draftOf(doc, x).locked = false;
  const locked = parts.filter((x) => draftOf(doc, x).locked);
  const transforms = a.rotate !== undefined || a.rotation !== undefined || a.mirrored !== undefined || a.scale !== undefined || !!a.align || !!a.distribute;
  if (transforms && locked.length) throw new EditError(`${locked.map((x) => refOf(doc, x)).join(", ")} ${locked.length === 1 ? "is" : "are"} locked in place — unlock with locked: false in the same call`);
  for (const x of parts) {
    const pg = getPage(doc, x.page.id);
    const e = draftOf(doc, x);
    const one = mkSel({ elements: [e.id] });
    let steps = a.rotate !== undefined ? turn(a.rotate) : a.rotation !== undefined ? (turn(a.rotation) - e.rot + 4) % 4 : 0;
    while (steps--) rotateSelection(doc, pg, one, true);
    if (a.mirrored !== undefined && !!e.mirror !== a.mirrored) mirrorSelection(doc, pg, one);
    if (a.scale !== undefined) {
      if (!(a.scale >= 20 && a.scale <= 500)) throw new EditError("scale is a percentage, 20–500");
      scaleElements(doc, pg, [e.id], () => a.scale! / 100);
    }
    if (a.hidden !== undefined) e.hidden = a.hidden || undefined;
    if (a.locked) e.locked = true;
  }
  if (a.rotate !== undefined || a.rotation !== undefined) done.push(a.rotation !== undefined ? `rotation ${turn(a.rotation) * 90}°` : `rotated ${turn(a.rotate!) * 90}° clockwise`);
  if (a.mirrored !== undefined) done.push(a.mirrored ? "mirrored" : "not mirrored");
  if (a.scale !== undefined) {
    const off = parts.filter((x) => offGridComponents(doc, getPage(doc, x.page.id)).some((q) => q.id === x.e.id));
    done.push(`size ${a.scale} %${off.length ? ` (pins of ${off.map((x) => refOf(doc, x)).join(", ")} are now off the grid, so wires to them bend — grid-friendly sizes: ${gridFriendlyScales(doc, draftOf(doc, off[0])).slice(0, 6).join(", ")} %)` : ""}`);
  }
  if (a.hidden !== undefined) done.push(a.hidden ? "hidden" : "shown");
  if (a.locked !== undefined) done.push(a.locked ? "locked" : "unlocked");
  if (a.align || a.distribute) {
    const pages = new Set(parts.map((x) => x.page.id));
    if (pages.size > 1) throw new EditError("Align and distribute components on one page");
    const pg = getPage(doc, parts[0].page.id);
    const els = parts.map((x) => draftOf(doc, x));
    if (a.align) {
      if (els.length < 2) throw new EditError("Align needs two or more components");
      const xs = els.map((e) => e.x), ys = els.map((e) => e.y);
      const al = a.align;
      const target = al === "left" ? Math.min(...xs) : al === "right" ? Math.max(...xs) : al === "center" ? Math.round((Math.min(...xs) + Math.max(...xs)) / 20) * 10 + 5 : al === "top" ? Math.min(...ys) : al === "bottom" ? Math.max(...ys) : Math.round((Math.min(...ys) + Math.max(...ys)) / 20) * 10 + 5;
      for (const e of els) {
        const horiz = al === "left" || al === "right" || al === "center";
        moveSelection(doc, pg, mkSel({ elements: [e.id] }), { x: horiz ? target - e.x : 0, y: horiz ? 0 : target - e.y });
      }
      done.push(`aligned ${al}`);
    }
    if (a.distribute) {
      if (els.length < 3) throw new EditError("Distribute needs three or more components");
      const axis = a.distribute === "horizontal" ? "x" : "y";
      const sorted = [...els].sort((p, q) => p[axis] - q[axis]);
      const first = sorted[0][axis], last = sorted[sorted.length - 1][axis];
      const step = (last - first) / (sorted.length - 1);
      sorted.forEach((e, i) => {
        const target = Math.round((first + step * i - 5) / 10) * 10 + 5;
        const delta = target - e[axis];
        moveSelection(doc, pg, mkSel({ elements: [e.id] }), axis === "x" ? { x: delta, y: 0 } : { x: 0, y: delta });
      });
      done.push(`distributed ${a.distribute}ly`);
    }
  }
  if (!done.length) throw new EditError("Nothing to change: give rotate, rotation, mirrored, scale, locked, hidden, align or distribute");
  return `${parts.map((x) => `${refOf(doc, x)}@${sheetNo(doc, x.page)}`).join(", ")}: ${done.join(", ")}; wires follow`;
}

const INFO_KEY: Record<string, (typeof COMPONENT_INFO)[number]["key"]> = { name: "description", description: "description", rating: "rating", part_number: "manufacturer_reference", manufacturer: "manufacturer" };
export type ComponentStyle = {
  pinNumbers?: boolean;
  pinNames?: boolean;
  /** which info lines are drawn under the reference */
  showInfo?: Partial<Record<"name" | "rating" | "part_number" | "manufacturer", boolean>>;
  infoPlacement?: Exclude<InfoPlacement, "free">;
  infoAlign?: "left" | "center" | "right";
  /** the reference text: turns with the component, or stays horizontal / vertical */
  referenceDirection?: "component" | "horizontal" | "vertical";
  /** symbol line colour; "" = project style */
  symbolColour?: string;
  /** box around the symbol; null = project style */
  outline?: Partial<Pick<ComponentFrame, "show" | "color" | "dash" | "padding">> | null;
  /** style of texts placed with the component: "reference" or an information name ("comment", "function" …) */
  texts?: { text: string; size?: number; colour?: string; visible?: boolean; bold?: boolean; italic?: boolean; reset?: boolean }[];
  resetLabelPositions?: boolean;
  resetOverrides?: boolean;
  /** make the info lines / placement of (the first of) these components the project default */
  projectDefault?: boolean;
};

/** How components are drawn: pin numbers / names, info lines, reference direction, colours, outline box, text styles. */
export function styleComponents(doc: Doc, refs: string[], st: ComponentStyle): string {
  const parts = partsOf(doc, refs);
  const done = new Set<string>();
  for (const x of parts) {
    const e = draftOf(doc, x);
    const def = x.def;
    if (st.resetOverrides) {
      for (const t of e.texts) delete t.override;
      delete e.outlineOverride;
      delete e.frame;
      done.add("style overrides reset");
    }
    if (st.resetLabelPositions && def) {
      for (const t of e.texts) {
        const dp = def.prims.find((p) => p.t === "dyntext" && ((t.uuid && p.uuid === t.uuid) || (p.info === t.info && t.info)));
        if (dp && dp.t === "dyntext") ((t.x = dp.x), (t.y = dp.y));
        else ((t.x = null), (t.y = null));
      }
      if (e.infoLayout?.pos) delete e.infoLayout.pos;
      if (e.mate?.labelPos) delete e.mate.labelPos;
      done.add("label positions reset");
    }
    if (st.pinNumbers !== undefined) ((e.showPinNumbers = st.pinNumbers), done.add(`pin numbers ${st.pinNumbers ? "shown" : "hidden"}`));
    if (st.pinNames !== undefined) ((e.showPinNames = st.pinNames), done.add(`pin names ${st.pinNames ? "shown" : "hidden"}`));
    if (st.showInfo) {
      const flags: ComponentInfoFlags = { ...(e.showInfo ?? {}) };
      for (const [k, v] of Object.entries(st.showInfo)) if (v !== undefined) flags[INFO_KEY[k]] = v;
      e.showInfo = flags;
      done.add(`info lines ${Object.entries(st.showInfo).map(([k, v]) => `${k} ${v ? "shown" : "hidden"}`).join(", ")}`);
    }
    if (st.infoPlacement || st.infoAlign) {
      e.infoLayout = { ...(e.infoLayout ?? {}), ...(st.infoPlacement ? { at: st.infoPlacement, pos: undefined } : {}), ...(st.infoAlign ? { align: st.infoAlign } : {}) };
      done.add(`info ${[st.infoPlacement && `placed ${st.infoPlacement}`, st.infoAlign && `aligned ${st.infoAlign}`].filter(Boolean).join(", ")}`);
    }
    if (st.referenceDirection) {
      const t = e.texts.find((y) => y.info === "label");
      if (t) {
        if (st.referenceDirection === "component") delete t.rotation;
        else t.rotation = st.referenceDirection === "horizontal" ? 0 : 90;
        done.add(`reference text ${st.referenceDirection === "component" ? "turns with the component" : st.referenceDirection}`);
      }
    }
    if (st.symbolColour !== undefined) {
      if (st.symbolColour.trim()) e.outlineOverride = { ...(e.outlineOverride ?? {}), color: st.symbolColour.trim() };
      else delete e.outlineOverride;
      done.add(st.symbolColour.trim() ? `symbol colour ${st.symbolColour.trim()}` : "symbol colour from the project style");
    }
    if (st.outline !== undefined) {
      if (st.outline === null) delete e.frame;
      else e.frame = { ...(e.frame ?? {}), ...Object.fromEntries(Object.entries(st.outline).filter(([, v]) => v !== undefined)) };
      done.add(st.outline === null ? "outline box from the project style" : `outline box ${st.outline.show === false ? "off" : "on"}`);
    }
    for (const ts of st.texts ?? []) {
      const key = ts.text.trim().toLowerCase();
      const info = key === "reference" || key === "ref" || key === "label" ? "label" : key === "name" ? "description" : key === "part_number" ? "manufacturer_reference" : key;
      const t = e.texts.find((y) => (y.info ?? "").toLowerCase() === info) ?? e.texts.find((y) => !y.info && y.text.toLowerCase() === key);
      if (!t) throw new EditError(`${refOf(doc, x)} has no text "${ts.text}" (texts: ${e.texts.map((y) => (y.info === "label" ? "reference" : y.info ?? y.text)).join(", ") || "none"}). Info lines (name, rating, part number, manufacturer) are styled project-wide with update_settings styles.`);
      if (ts.reset) delete t.override;
      const o: Partial<TextStyle> = { ...(t.override ?? {}) };
      if (ts.size !== undefined) o.size = ts.size;
      if (ts.colour !== undefined) o.color = ts.colour;
      if (ts.visible !== undefined) o.visible = ts.visible;
      if (ts.bold !== undefined) o.weight = ts.bold ? 700 : 400;
      if (ts.italic !== undefined) o.italic = ts.italic;
      if (Object.keys(o).length) t.override = o;
      done.add(`text ${ts.text} styled`);
    }
  }
  if (st.projectDefault) {
    const e = draftOf(doc, parts[0]);
    const base = doc.styles.graphics ?? {};
    const defaults = { ...((base.componentInfo as ComponentInfoFlags | undefined) ?? {}), ...(e.showInfo ?? {}) };
    const lay = { ...((base.componentInfoLayout as object | undefined) ?? {}), ...(e.infoLayout ?? {}) } as { at?: InfoPlacement; align?: "left" | "center" | "right"; pos?: Pt };
    if (lay.at === "free") lay.at = "auto";
    delete lay.pos;
    doc.styles = { ...doc.styles, graphics: { ...base, componentInfo: defaults, componentInfoLayout: lay } };
    for (const p of doc.pages)
      for (const x of p.elements) {
        delete x.showInfo;
        delete x.infoLayout;
      }
    done.add("info lines and placement are now the project default (per-component settings cleared)");
  }
  if (!done.size) throw new EditError("Nothing to change");
  return `${parts.map((x) => refOf(doc, x)).join(", ")}: ${[...done].join("; ")}`;
}

/* ------------------------------------------------------------------ */
/* Off-page arrows (folio reports)                                      */
/* ------------------------------------------------------------------ */

/**
 * Off-page arrows: link every going / coming pair with the same reference (auto), link or unlink
 * two arrows, or mark an arrow symbol as going / coming so several arrows may share a name.
 */
export function folioReports(doc: Doc, mode: "auto" | "link" | "unlink" | "mark_going" | "mark_coming", arrow?: string, to?: string): string {
  if (mode === "auto") {
    const n = autoLinkReports(doc);
    return n ? `Linked ${n} arrow pair${n === 1 ? "" : "s"} with the same reference` : "No unlinked going / coming arrows share a reference";
  }
  if (!arrow) throw new EditError("Give the arrow (its reference or #id)");
  const a = findComponent(doc, arrow);
  if (mode === "mark_going" || mode === "mark_coming") {
    if (!a.def) throw new EditError("The arrow has no symbol");
    if (!isReportDef(a.def) && !looksLikeArrow(a.def)) throw new EditError(`${refOf(doc, a)} (${a.def.name}) does not look like an off-page arrow`);
    doc.defs[a.def.id].linkType = mode === "mark_going" ? "next_report" : "previous_report";
    const n = autoLinkReports(doc, (a.e.info.label ?? "").trim() || undefined);
    return `Symbol "${a.def.name}" is now a ${mode === "mark_going" ? "going" : "coming"} folio report (every arrow with this symbol)${n ? `; linked ${n} pair${n === 1 ? "" : "s"}` : ""}`;
  }
  if (!isReportDef(a.def)) throw new EditError(`${refOf(doc, a)} is not marked as an off-page arrow — use mode mark_going / mark_coming first`);
  if (mode === "unlink") {
    const b = to ? findComponent(doc, to) : null;
    const before = a.e.links?.length ?? 0;
    unlinkReport(doc, a.e.id, b?.e.id);
    return `Unlinked ${refOf(doc, a)}@${sheetNo(doc, a.page)}${b ? ` from ${refOf(doc, b)}@${sheetNo(doc, b.page)}` : ` (${before} link${before === 1 ? "" : "s"})`}`;
  }
  if (!to) throw new EditError("Give the arrow to link to");
  const b = findComponent(doc, to);
  if (!isReportDef(b.def)) throw new EditError(`${refOf(doc, b)} is not an off-page arrow`);
  if (a.def!.linkType === b.def!.linkType) throw new EditError("Link a going arrow to a coming arrow");
  linkReports(doc, a.e.id, b.e.id);
  const la = (a.e.info.label ?? "").trim();
  if (la && !(b.e.info.label ?? "").trim()) draftOf(doc, b).info.label = la;
  return `Linked ${refOf(doc, a)}@${sheetNo(doc, a.page)} → ${refOf(doc, b)}@${sheetNo(doc, b.page)}`;
}

/* ------------------------------------------------------------------ */
/* Symbols                                                              */
/* ------------------------------------------------------------------ */

/** Give components another symbol, keeping position, reference, data and wires (moved to matching pins). */
export function replaceSymbols(doc: Doc, refs: string[], def: ElementDef): string {
  const parts = partsOf(doc, refs);
  let moved = 0, loose = 0;
  for (const x of parts) {
    const r = replaceSymbolCore(doc, getPage(doc, x.page.id), draftOf(doc, x), def);
    moved += r.moved;
    loose += r.loose;
  }
  return `${parts.map((x) => refOf(doc, x)).join(", ")} now drawn as "${def.name}"; ${moved} wire end${moved === 1 ? "" : "s"} moved to the new pins${loose ? `; ${loose} wire end${loose === 1 ? "" : "s"} had no matching pin and are now free (check them)` : ""}`;
}

/**
 * Change the pins of a symbol in this project (every component drawn with it): number, name,
 * what the pin carries (for the electrical check), nominal voltage.
 */
export function setSymbolPins(doc: Doc, ref: string, pins: { pin: string; number?: string; name?: string; kind?: string; volts?: number | null }[]): string {
  const x = findComponents(doc, ref)[0];
  if (!x.def) throw new EditError(`${ref} has no symbol`);
  const def = doc.defs[x.def.id];
  const users = doc.pages.reduce((n, p) => n + p.elements.filter((e) => e.defId === def.id).length, 0);
  const out: string[] = [];
  for (const p of pins) {
    const s = p.pin.trim().toLowerCase();
    const pos = /^p(\d+)$/.exec(s);
    const pin = def.pins.find((q) => (q.number ?? "").toLowerCase() === s) ?? def.pins.find((q) => (q.name ?? "").toLowerCase() === s) ?? (pos ? def.pins[Number(pos[1]) - 1] : undefined);
    if (!pin) throw new EditError(`"${def.name}" has no pin "${p.pin}" (pins: ${def.pins.map((q) => pinLabel(q, def)).join(", ")})`);
    const was = pinLabel(pin, def);
    if (p.number !== undefined) pin.number = p.number.trim();
    if (p.name !== undefined) pin.name = p.name.trim();
    if (p.kind !== undefined) {
      const k = p.kind.trim();
      if (!k) delete pin.cls;
      else if (!PIN_CLASSES.some((c) => c.id === k)) throw new EditError(`kind must be one of ${PIN_CLASSES.map((c) => c.id).join(", ")} (or "" to detect from the name)`);
      else pin.cls = k as PinClass;
    }
    if (p.volts !== undefined) {
      if (p.volts === null) delete pin.volts;
      else pin.volts = p.volts;
    }
    out.push(`${was}${p.number !== undefined || p.name !== undefined ? ` → ${pinLabel(pin, def)}${pin.name && pin.name !== pin.number ? ` (${pin.name})` : ""}` : ""}${pin.cls ? ` ${pin.cls}` : ""}${pin.volts !== undefined ? ` ${pin.volts} V` : ""}`);
  }
  return `Symbol "${def.name}" (${users} component${users === 1 ? "" : "s"} in this project${def.source?.libraryElementId ? "; now differs from its library element" : ""}): ${out.join(", ")}`;
}

/* ------------------------------------------------------------------ */
/* Copying                                                              */
/* ------------------------------------------------------------------ */

/**
 * Copy components (with the wires and junctions between them) to the same or another page, like
 * copy & paste in the editor: new references by the numbering rules unless renumber is false;
 * device parts copied together keep sharing their (new) reference; a plug and socket stay mated.
 */
export function copyComponents(doc: Doc, refs: string[], o: { toPage?: string; at?: Pt; dx?: number; dy?: number; renumber?: boolean }): string {
  const parts = partsOf(doc, refs);
  const pages = new Set(parts.map((x) => x.page.id));
  if (pages.size > 1) throw new EditError("Copy components of one page at a time");
  const src = getPage(doc, parts[0].page.id);
  const dest = o.toPage ? getPage(doc, findPage(doc, o.toPage).id) : src;
  const ids = new Set(parts.map((x) => x.e.id));
  // junctions whose wires all lead to copied components come along
  const js = src.junctions.filter((j) => {
    const ws = src.wires.filter((w) => (w.a.k === "junction" && w.a.j === j.id) || (w.b.k === "junction" && w.b.j === j.id));
    return ws.length > 0 && ws.every((w) => [w.a, w.b].every((e) => e.k !== "pin" || ids.has(e.el)));
  });
  const clip = copySelection(doc, src, mkSel({ elements: [...ids], junctions: js.map((j) => j.id) }));
  const first = parts[0].e;
  let off: Pt;
  if (o.at) off = { x: o.at.x - first.x, y: o.at.y - first.y };
  else if (o.dx !== undefined || o.dy !== undefined) off = { x: o.dx ?? 0, y: o.dy ?? 0 };
  else off = dest.id === src.id ? { x: 40, y: 40 } : { x: 0, y: 0 };
  const sel = pasteClip(doc, dest, clip, off, o.renumber !== false);
  const made = sel.elements.map((id) => dest.elements.find((e) => e.id === id)!).map((e) => e.info.label || doc.defs[e.defId]?.name || short(e.id));
  return `Copied ${parts.length} component${parts.length === 1 ? "" : "s"} and ${sel.wires.length} wire${sel.wires.length === 1 ? "" : "s"} to page ${sheetNo(doc, dest)} (offset ${off.x}, ${off.y}): ${made.join(", ")}`;
}

/* ------------------------------------------------------------------ */
/* Drawing wires                                                        */
/* ------------------------------------------------------------------ */

/** one end of a wire to draw: a pin, a point on an existing wire (T-junction), a junction, or a free point */
export type EndSpec = { pin?: string; wire?: string; junction?: string; at?: Pt; cell?: string };
type Resolved = { page: Page; target: EndTarget; orient: Orient | null; text: string };

function resolveSpec(doc: Doc, spec: EndSpec, pageHint: Page | null, other: Pt | null): Resolved | ((other: Pt) => Resolved) {
  if (spec.pin) {
    const p = findPin(doc, spec.pin);
    if (pageHint && p.page.id !== pageHint.id) throw new EditError(`${spec.pin} is on page ${sheetNo(doc, p.page)}, not page ${sheetNo(doc, pageHint)}`);
    const at = toScene(p.e, p.pin);
    return { page: p.page, target: { k: "pin", el: p.e.id, pin: p.pin.id, p: at }, orient: pinOrientScene(p.e, p.def!, p.pin.id), text: `${refOf(doc, p)}:${pinLabel(p.pin, p.def)}` };
  }
  if (spec.junction) {
    const k = spec.junction.replace(/^#/, "").replace(/-/g, "").toLowerCase();
    for (const page of doc.pages) {
      const j = page.junctions.find((x) => x.id.replace(/-/g, "").toLowerCase().startsWith(k));
      if (j) return { page, target: { k: "junction", j: j.id, p: { x: j.x, y: j.y } }, orient: null, text: `junction ${short(j.id)}` };
    }
    throw new EditError(`No junction ${spec.junction}`);
  }
  if (spec.wire) {
    const ws = findWires(doc, spec.wire);
    if (ws.length > 1) throw new EditError(`Wire number ${spec.wire} is on ${ws.length} conductors — give the wire id (#…)`);
    const { w, page } = ws[0];
    const make = (toward: Pt): Resolved => {
      const n = nearestSegment(w.pts, spec.at ?? (spec.cell ? positionOf(doc, page, { cell: spec.cell }) : toward));
      if (!n) throw new EditError("That wire has no segments");
      const g = doc.grid?.size || 10;
      // on the grid when the segment allows it
      const a = w.pts[n.i], b = w.pts[n.i + 1];
      const horizontal = Math.abs(a.y - b.y) < 0.01;
      const snapped = horizontal ? { x: Math.round((n.p.x - 5) / g) * g + 5, y: a.y } : { x: a.x, y: Math.round((n.p.y - 5) / g) * g + 5 };
      const inside = horizontal ? snapped.x >= Math.min(a.x, b.x) && snapped.x <= Math.max(a.x, b.x) : snapped.y >= Math.min(a.y, b.y) && snapped.y <= Math.max(a.y, b.y);
      const p = inside ? snapped : n.p;
      return { page, target: { k: "wire", wire: w.id, seg: n.i, p }, orient: null, text: `wire ${w.label || short(w.id)}` };
    };
    if (spec.at || spec.cell || other) return make(other ?? { x: 0, y: 0 });
    return make;
  }
  if (spec.at || spec.cell) {
    if (!pageHint) throw new EditError("Give the page for a wire end at a point");
    const p = positionOf(doc, pageHint, { cell: spec.cell, x: spec.at?.x, y: spec.at?.y });
    // like snapping in the editor: a point on a pin, a free wire end or a wire connects there
    for (const e of pageHint.elements) {
      const def = doc.defs[e.defId];
      for (const pin of def?.pins ?? []) if (eqPt(toScene(e, pin), p, 0.5)) return { page: pageHint, target: { k: "pin", el: e.id, pin: pin.id, p }, orient: pinOrientScene(e, def!, pin.id), text: `${refOf(doc, { e, def })}:${pinLabel(pin, def)}` };
    }
    for (const j of pageHint.junctions) if (eqPt(j, p, 0.5)) return { page: pageHint, target: { k: "junction", j: j.id, p }, orient: null, text: `junction ${short(j.id)}` };
    for (const w of pageHint.wires) {
      if (w.a.k === "free" && eqPt(w.pts[0], p, 0.5)) return { page: pageHint, target: { k: "wireEnd", wire: w.id, end: "a", p }, orient: null, text: `end of wire ${w.label || short(w.id)}` };
      if (w.b.k === "free" && eqPt(w.pts[w.pts.length - 1], p, 0.5)) return { page: pageHint, target: { k: "wireEnd", wire: w.id, end: "b", p }, orient: null, text: `end of wire ${w.label || short(w.id)}` };
      const n = nearestSegment(w.pts, p);
      if (n && n.d < 0.5) return { page: pageHint, target: { k: "wire", wire: w.id, seg: n.i, p }, orient: null, text: `wire ${w.label || short(w.id)}` };
    }
    return { page: pageHint, target: { k: "free", p }, orient: null, text: `free end at (${p.x}, ${p.y})` };
  }
  throw new EditError("Each end needs pin, wire, junction, or a point (at / cell)");
}

/** orthogonal path through the given points (an elbow is added between points that are not in line) */
function orthoThrough(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) out.push({ x: b.x, y: a.y });
    out.push(b);
  }
  return simplify(out);
}

/**
 * Draw a wire between any two ends — pins, a point on an existing wire (makes a T-junction), a
 * junction, or a free point — routed orthogonally, or through the given points.
 */
export function drawWire(doc: Doc, from: EndSpec, to: EndSpec, o: { page?: string; via?: Pt[]; number?: string } = {}): { text: string; wireId: string } {
  const hint = o.page ? findPage(doc, o.page) : null;
  const pin = (s: EndSpec) => (s.pin ? findPin(doc, s.pin).page : s.wire ? findWires(doc, s.wire)[0].page : null);
  const pageOf = hint ?? pin(from) ?? pin(to);
  let ra = resolveSpec(doc, from, pageOf, null);
  let rb = resolveSpec(doc, to, pageOf, null);
  if (typeof ra === "function" && typeof rb === "function") throw new EditError("Say where on the wire to connect: give at (x, y) or cell for one of the wire ends");
  if (typeof ra === "function") ra = ra((rb as Resolved).target.p);
  if (typeof rb === "function") rb = rb(ra.target.p);
  const A = ra, B = rb as Resolved;
  if (A.page.id !== B.page.id) throw new EditError(`The ends are on page ${sheetNo(doc, A.page)} and page ${sheetNo(doc, B.page)}: a wire joins points on one sheet — use off-page arrows with the same name on both sheets`);
  const pg = getPage(doc, A.page.id);
  const g = doc.grid?.size || 10;
  const via = (o.via ?? []).map((p) => ({ x: Math.round((p.x - 5) / g) * g + 5, y: Math.round((p.y - 5) / g) * g + 5 }));
  const pts = via.length ? orthoThrough([A.target.p, ...via, B.target.p]) : orthoRoute(A.target.p, B.target.p, A.orient, B.orient);
  const w = addWire(pg, A.target, B.target, pts, o.number?.trim() ? { label: o.number.trim(), labelLocked: true } : {});
  if (!w) throw new EditError("No wire was drawn (both ends are the same point or the same connection)");
  return { text: `Wire ${short(w.id)} on page ${sheetNo(doc, A.page)}: ${A.text} → ${B.text}${w.label ? `, number ${w.label}` : ""}`, wireId: w.id };
}

/**
 * Change a wire's path: new points (its ends stay where they are connected), an automatic
 * orthogonal re-route, or move one end to another pin / wire / point.
 */
export function routeWire(doc: Doc, wireRef: string, o: { points?: Pt[]; reroute?: boolean; reconnect?: { end: "start" | "end"; to: EndSpec } }): string {
  const ws = findWires(doc, wireRef);
  if (ws.length > 1) throw new EditError(`Wire number ${wireRef} is on ${ws.length} conductors — give the wire id (#…)`);
  const pg = getPage(doc, ws[0].page.id);
  const id = ws[0].w.id;
  const w = () => pg.wires.find((x) => x.id === id);
  const done: string[] = [];
  if (o.reconnect) {
    const end = o.reconnect.end === "start" ? "a" : "b";
    const r = resolveSpec(doc, o.reconnect.to, ws[0].page, null);
    const R = typeof r === "function" ? r(end === "a" ? w()!.pts[w()!.pts.length - 1] : w()!.pts[0]) : r;
    if (R.page.id !== pg.id) throw new EditError("Reconnect to something on the same page");
    reattachEnd(doc, pg, id, end, R.target);
    done.push(`${o.reconnect.end} reconnected to ${R.text}`);
  }
  const cur = w();
  if (!cur) return done.join("; ") || "The wire was merged into another one";
  if (o.points?.length) {
    if (o.points.length < 2) throw new EditError("A path needs at least two points");
    const first = o.points[0], last = o.points[o.points.length - 1];
    const a = cur.pts[0], b = cur.pts[cur.pts.length - 1];
    if (cur.a.k !== "free" && !eqPt(first, a, 0.5)) throw new EditError(`The wire's start is connected at (${a.x}, ${a.y}) — start the path there (or reconnect the start first)`);
    if (cur.b.k !== "free" && !eqPt(last, b, 0.5)) throw new EditError(`The wire's end is connected at (${b.x}, ${b.y}) — end the path there (or reconnect the end first)`);
    cur.pts = orthoThrough(o.points);
    done.push(`path set (${cur.pts.length} points)`);
  } else if (o.reroute) {
    const orient = (e: Wire["a"]) => {
      if (e.k !== "pin") return null;
      const el = pg.elements.find((x) => x.id === e.el);
      const def = el && doc.defs[el.defId];
      return el && def ? pinOrientScene(el, def, e.pin) : null;
    };
    cur.pts = orthoRoute(cur.pts[0], cur.pts[cur.pts.length - 1], orient(cur.a), orient(cur.b));
    done.push("re-routed");
  }
  if (!done.length) throw new EditError("Give points, reroute or reconnect");
  cleanupJunctions(pg);
  const after = w();
  return `Wire ${short(id)}: ${done.join("; ")}${after ? `; path ${after.pts.map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(" ")}` : ""}`;
}

/** Turn lines drawn as shapes into wires (as "Convert lines to wires" in the editor). */
export function convertLines(doc: Doc, pageRef: string, ids?: string[]): string {
  const pg = getPage(doc, findPage(doc, pageRef).id);
  const lines = pg.shapes.filter(isOpenPath);
  const pick = ids?.length
    ? ids.map((s) => {
        const k = s.replace(/^#/, "").replace(/-/g, "").toLowerCase();
        const x = lines.find((l) => l.id.replace(/-/g, "").toLowerCase().startsWith(k));
        if (!x) throw new EditError(`No drawn line ${s} on page ${sheetNo(doc, pg)} (list_page_items shows them)`);
        return x.id;
      })
    : lines.map((l) => l.id);
  if (!pick.length) throw new EditError(`Page ${sheetNo(doc, pg)} has no drawn lines`);
  const r = convertShapesToWires(doc, pg, pick);
  return `Converted ${r.converted} line${r.converted === 1 ? "" : "s"} into ${r.wires.length} wire${r.wires.length === 1 ? "" : "s"}${r.pinEnds ? `; ${r.pinEnds} end${r.pinEnds === 1 ? "" : "s"} connected to pins` : ""}`;
}

/* ------------------------------------------------------------------ */
/* Cables                                                               */
/* ------------------------------------------------------------------ */

export type CablePatch = {
  rename?: string;
  type?: string;
  /** a core count (cores made by `scheme`) or the cores by name and colour */
  cores?: number | { name: string; colour?: string }[];
  scheme?: CoreScheme;
  earth?: boolean;
  section?: string;
  shield?: boolean;
  length?: string;
  note?: string;
  addWires?: string[];
  removeWires?: string[];
  delete?: boolean;
};

/** Create, change or delete a multi-core cable and put wires into it (cores assigned like the editor). */
export function setCable(doc: Doc, tag: string | undefined, p: CablePatch): string {
  doc.cables ??= [];
  let t = tag?.trim() || "";
  let c = t ? doc.cables.find((x) => x.tag === t) : undefined;
  const wiresOf = (specs: string[]) => [...new Set(specs.flatMap((s) => findWires(doc, s).map((x) => x.w.id)))];
  if (p.delete) {
    if (!c && !doc.pages.some((pg) => pg.wires.some((w) => w.cable === t))) throw new EditError(`No cable ${t}`);
    let n = 0;
    for (const pg of doc.pages) for (const w of pg.wires) if (w.cable === t) (delete w.cable, delete w.core, n++);
    doc.cables = doc.cables.filter((x) => x.tag !== t);
    return `Deleted cable ${t}; ${n} wire${n === 1 ? "" : "s"} no longer in a cable`;
  }
  const out: string[] = [];
  const created = !c;
  if (!c) {
    t ||= nextCableTag(doc);
    const add = p.addWires ? wiresOf(p.addWires) : [];
    const ws = doc.pages.flatMap((pg) => pg.wires.filter((w) => add.includes(w.id)));
    const earth = p.earth ?? ws.some((w) => wirePot(w) === "PE");
    const n = typeof p.cores === "number" ? p.cores : Array.isArray(p.cores) ? p.cores.length : Math.max(2, ws.length + (earth && !ws.some((w) => wirePot(w) === "PE") ? 1 : 0));
    c = { id: crypto.randomUUID(), tag: t, cores: Array.isArray(p.cores) ? p.cores.map((k) => ({ name: k.name, ...(k.colour ? { color: k.colour } : {}) })) : makeCores(n, p.scheme ?? (n <= 5 ? "colors" : "numbered"), earth) };
    doc.cables.push(c);
    out.push(`Created cable ${t} (${cableDesignation(c)})`);
  }
  const cable = doc.cables.find((x) => x.tag === c!.tag)!;
  if (!created && p.cores !== undefined) {
    cable.cores = Array.isArray(p.cores) ? p.cores.map((k) => ({ name: k.name, ...(k.colour ? { color: k.colour } : {}) })) : makeCores(p.cores, p.scheme ?? (p.cores <= 5 ? "colors" : "numbered"), p.earth ?? cable.cores.some((k) => (k.color ?? k.name) === "GNYE"));
    out.push(`cores ${cable.cores.map((k) => k.name).join(", ")}`);
  }
  for (const [k, v] of [["type", p.type], ["section", p.section], ["length", p.length], ["note", p.note]] as const) {
    if (v === undefined) continue;
    if (v.trim()) cable[k] = v.trim();
    else delete cable[k];
    out.push(`${k}=${v.trim() || "(cleared)"}`);
  }
  if (p.shield !== undefined) ((cable.shield = p.shield || undefined), out.push(p.shield ? "shielded" : "not shielded"));
  if (p.rename?.trim() && p.rename.trim() !== cable.tag) {
    const nt = p.rename.trim();
    if (doc.cables.some((x) => x.tag === nt)) throw new EditError(`Cable ${nt} already exists`);
    for (const pg of doc.pages) for (const w of pg.wires) if (w.cable === cable.tag) w.cable = nt;
    out.push(`renamed ${cable.tag} → ${nt}`);
    cable.tag = nt;
  }
  if (p.removeWires?.length) {
    const ids = wiresOf(p.removeWires);
    let n = 0;
    for (const pg of doc.pages) for (const w of pg.wires) if (ids.includes(w.id) && w.cable === cable.tag) (delete w.cable, delete w.core, n++);
    out.push(`${n} wire${n === 1 ? "" : "s"} taken out`);
  }
  if (p.addWires?.length) {
    const ids = wiresOf(p.addWires);
    const ws = doc.pages.flatMap((pg) => pg.wires.filter((w) => ids.includes(w.id)));
    assignCores(doc, cable, ws);
    const noCore = ws.filter((w) => !w.core).length;
    out.push(`${ws.length} wire${ws.length === 1 ? "" : "s"} in the cable: ${ws.map((w) => `${w.label || short(w.id)}→${w.core ?? "no core"}`).join(", ")}${noCore ? ` (${noCore} without a free core — add cores)` : ""}`);
  }
  if (!out.length) throw new EditError("Nothing to change");
  return `${created ? "" : `Cable ${cable.tag}: `}${out.join("; ")}`;
}

/* ------------------------------------------------------------------ */
/* Straightening                                                        */
/* ------------------------------------------------------------------ */

/**
 * Straighten wires on a page: line the given components up with what they are wired to (a mated
 * plug and socket drawn together move as one; sizes that put pins off the grid are corrected), then
 * draw every wire that can be straight as a straight line. Without components nothing moves and
 * only the wires are redrawn.
 */
export function straighten(doc: Doc, pageRef: string, o: { components?: string[] | "all"; wires?: string[]; reroute?: boolean; fixSizes?: boolean }): string {
  const pg = getPage(doc, findPage(doc, pageRef).id);
  const move = o.components === "all" ? pg.elements.filter((e) => !e.locked).map((e) => e.id) : o.components?.length ? partsOf(doc, o.components).filter((x) => x.page.id === pg.id).map((x) => x.e.id) : [];
  if (o.components && o.components !== "all" && o.components.length && !move.length) throw new EditError(`None of those components is on page ${sheetNo(doc, pg)}`);
  const wires = o.wires?.length ? [...new Set(o.wires.flatMap((w) => findWires(doc, w).filter((x) => x.page.id === pg.id).map((x) => x.w.id)))] : undefined;
  const r = straightenWires(doc, pg, { move, wires, reroute: o.reroute, fixSizes: o.fixSizes });
  const name = (id: string) => {
    const e = pg.elements.find((x) => x.id === id);
    return e ? refOf(doc, { e, def: doc.defs[e.defId] }) : short(id);
  };
  const bent = pg.wires.filter((w) => !(w.a.k === "junction" && w.b.k === "junction" && w.a.j === w.b.j) && despike(simplify(w.pts)).length > 2);
  const lines = [
    `Page ${sheetNo(doc, pg)}: ${r.straight.length} wire${r.straight.length === 1 ? "" : "s"} straight${r.rerouted.length ? `, ${r.rerouted.length} re-routed` : ""}${r.tidied.length ? `, ${r.tidied.length} tidied` : ""}; ${bent.length} wire${bent.length === 1 ? "" : "s"} on the page still bend`,
    r.resized.length ? `Resized so their pins are on the grid: ${r.resized.map((x) => `${name(x.id)} ${x.from} % → ${x.to} %`).join(", ")}` : "",
    r.moved.length ? `Moved (${r.moved.length}): ${r.moved.slice(0, 15).map((m) => `${name(m.id)} by (${m.dx}, ${m.dy}) — ${m.lined} of ${m.of} wire${m.of === 1 ? "" : "s"} in line`).join("; ")}${r.moved.length > 15 ? ` … +${r.moved.length - 15}` : ""}` : "",
    stayedText(r.stayed, name),
    r.blocked.length ? `Left bent because a straight line would cross a symbol: ${r.blocked.map((id) => { const w = pg.wires.find((q) => q.id === id); return `${w?.label || "·"} ${short(id)}`; }).join(", ")}${o.reroute ? "" : " (reroute: true gives them the fewest bends)"}` : "",
    r.offGrid.length ? `Pins off the grid (wires to them cannot be straight): ${r.offGrid.map((x) => { const e = pg.elements.find((q) => q.id === x.id)!; const ok = gridFriendlyScales(doc, e); return `${name(x.id)} at ${Math.round(x.scale * 100)} %${ok.length ? ` (on the grid at ${ok.slice(0, 6).join(", ")} %)` : ""}`; }).join("; ")}` : "",
    bent.length && bent.length <= 30 ? `Still bending: ${bent.map((w) => `${w.label || "·"} ${short(w.id)}`).join(", ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** components that did not move, grouped by why (a page-wide run would otherwise list every one) */
function stayedText(stayed: { id: string; why: string }[], name: (id: string) => string): string {
  if (!stayed.length) return "";
  const by = new Map<string, string[]>();
  for (const x of stayed) {
    const why = x.why.startsWith("already in line") ? "already in line" : /moving would take one out of line/.test(x.why) ? "moving would take a straight wire out of line" : x.why;
    by.set(why, [...(by.get(why) ?? []), name(x.id)]);
  }
  const list = (n: string[]) => (n.length > 12 ? `${n.slice(0, 12).join(", ")} … +${n.length - 12}` : n.join(", "));
  if (stayed.length <= 6) return `Stayed: ${stayed.map((x) => `${name(x.id)} (${x.why})`).join("; ")}`;
  return `Stayed (${stayed.length}): ${[...by].sort((a, b) => b[1].length - a[1].length).map(([why, n]) => `${why} (${n.length}): ${list(n)}`).join("; ")}`;
}

export { AddressError };
