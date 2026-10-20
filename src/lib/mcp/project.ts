/**
 * Project-level drawing data for an AI assistant: settings (properties, revisions, reference
 * numbering, wire numbering, wiring display, styles), terminal strips, cables, and text reports
 * (bill of materials, wire list, terminal plan, cable list). Same rules as the editor's dialogs;
 * no server dependencies (unit tested).
 */
import type { Doc, ElementDef, GraphicStyles, NumberingRule, RevisionEntry, StripRow, TerminalType, TextRole, TextStyle, WireClass, WireNumbering, WiringSettings } from "@/core/model";
import { TEXT_ROLES } from "@/core/model";
import { getPage, newElement } from "@/core/ops";
import { uid } from "@/core/ids";
import { defaultStyles, deepMerge, projectStyles } from "@/core/styles";
import { PRESETS, RESERVED_CLASS_LETTERS, wireNumberingOf } from "@/core/wirenumber";
import { STANDARDS, wiringOf, wireInfo, wirePot, wireUse, cableDesignation } from "@/core/wiring";
import { buildBom, bomCell, bomColumns, compactRefs, type BomGrouping } from "@/core/bom";
import { addSpare, assignToStrip, collectStrips, createStrip, deleteStrip, moveToStrip, placeTerminals, removeRow, renumberStrip, setOrder, setRow, setStrip, setTerminalNumber, stripOf, terminalSymbols, TERMINAL_TYPES, terminalTypeLabel, type StripView } from "@/core/terminals";
import { gridRef } from "@/core/xref";
import { findPage, positionOf, refOf, sheetNo, sheets, short, allWires } from "./doc";
import { EditError } from "./edits";
import { titleBlockText } from "./sheets";

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

export const SETTINGS_SECTIONS = ["properties", "revisions", "numbering", "wire_numbering", "wiring", "styles", "title_blocks"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function settingsText(doc: Doc, only?: SettingsSection[]): string {
  const want = (s: SettingsSection) => !only?.length || only.includes(s);
  const out: string[] = [];
  if (want("properties")) {
    out.push(`PROPERTIES — drawing title "${doc.meta.title}" (%projecttitle)`);
    const props = Object.entries(doc.meta.props ?? {});
    out.push(props.length ? props.map(([k, v]) => `  ${k} = ${v || "(empty)"}`).join("\n") : "  (no project properties)");
  }
  if (want("revisions")) {
    out.push("REVISIONS (cover sheet history, oldest first)");
    out.push((doc.revisions ?? []).length ? doc.revisions!.map((r, i) => `  ${i + 1}. rev ${r.rev} | ${r.date} | ${r.description} | drawn ${r.drawn ?? "-"} | checked ${r.checked ?? "-"} | approved ${r.approved ?? "-"}`).join("\n") : "  (none)");
  }
  if (want("numbering")) {
    out.push(`NUMBERING — references given when placing: ${doc.numbering.autoOnPlace ? "yes" : "no"}; close gaps when deleting: ${doc.numbering.closeGapsOnDelete === false ? "no" : "yes"}`);
    out.push(doc.numbering.rules.map((r) => `  match ${r.match} → prefix ${r.prefix || "(symbol prefix)"}, format ${r.format}, per ${r.scope}, start ${r.start}`).join("\n") || "  (no rules: symbol prefixes)");
  }
  if (want("wire_numbering")) {
    const w = wireNumberingOf(doc);
    out.push(`WIRE NUMBERING${doc.wireNumbering ? "" : " (defaults, not saved yet)"} — preset ${w.preset}; format ${w.format} (tokens {class} {n} {n:3} {seg} {ret} {page} {col} {row} {size}); one letter per segment ${w.segments ? "yes" : "no"}; return suffix "${w.returnSuffix}"; PE letter ${w.peLetter}; 0 V numbered ${w.gndMode === "letter" ? `with letter ${w.gndLetter || "G"}` : "as the return of its supply"}; unknown voltage letter ${w.fallbackLetter}; default DC supply ${w.defaultDc ?? "-"}, AC ${w.defaultAc ?? "-"}; start ${w.start}; replace rail names ${w.replacePotentialNames ? "yes" : "no"}`);
    out.push("  supplies (letter | id | name | kind | volts | use | match):");
    out.push(w.classes.map((c) => `  ${c.letter} | ${c.id} | ${c.name} | ${c.kind} | ${c.volts ?? "-"} | ${c.use ?? "auto"} | ${c.match ?? "-"}`).join("\n"));
  }
  if (want("wiring")) {
    const w = wiringOf(doc);
    out.push(`WIRING — standard ${STANDARDS[w.standard].name}; show colour ${w.showColor ? "yes" : "no"}; show cross-section ${w.showSection ? "yes" : "no"}; tick ${w.tick ? "yes" : "no"}; colour wires by function ${w.colorize ? "yes" : "no"}; number at ${w.numberAt ?? "middle"}; destination at ends ${w.destination ? "yes" : "no"}; heavier lines for larger sections ${w.weightBySection ? "yes" : "no"}`);
  }
  if (want("styles")) {
    const eff = projectStyles(doc.baseStyles, doc.styles);
    out.push(`STYLES${doc.baseStylesRef ? ` (based on "${doc.baseStylesRef.name}" v${doc.baseStylesRef.version})` : ""} — text roles: font size weight colour visible (* = changed in this project)`);
    for (const r of TEXT_ROLES) {
      const t = eff.text[r];
      out.push(`  ${r}${doc.styles.text?.[r] ? "*" : ""}: ${t.font} ${t.size}pt ${t.weight}${t.italic ? " italic" : ""} ${t.color}${t.visible ? "" : " hidden"}`);
    }
    const g = eff.graphics;
    out.push(`  graphics${doc.styles.graphics ? "*" : ""}: wire ${g.wire.color} ${g.wire.width} ${g.wire.dash}, junction r${g.wire.junctionRadius}; bus ${g.bus.color} ${g.bus.width}; pins ${g.pin.color} size ${g.pin.size}${g.pin.showPoint ? " points" : ""}; symbol lines ${g.outline.color ?? "as drawn"} ×${g.outline.widthScale}; outline box ${g.frame?.show ? `${g.frame.color} ${g.frame.dash}` : "off"}; info lines ${Object.entries(g.componentInfo ?? {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"} (${g.componentInfoLayout?.at ?? "auto"}); border ${g.border.color}; title block ${g.titleBlock.color}`);
  }
  if (want("title_blocks")) {
    out.push("TITLE BLOCK TEMPLATES");
    for (const t of Object.values(doc.titleBlocks)) out.push(titleBlockText(t).replace(/^/gm, "  ") + `\n  used by pages ${sheets(doc).filter((p) => p.titleBlock.template === t.name).map((p) => sheetNo(doc, p)).join(", ") || "none"}`);
  }
  return out.join("\n");
}

export type SettingsPatch = {
  drawingTitle?: string;
  /** project properties (%variables in title blocks); "" removes one */
  properties?: Record<string, string>;
  revisions?: RevisionEntry[];
  addRevision?: RevisionEntry;
  numbering?: { rules?: Omit<NumberingRule, "id">[]; autoOnPlace?: boolean; closeGapsOnDelete?: boolean };
  wireNumbering?: Partial<Omit<WireNumbering, "classes">> & { classes?: (Omit<WireClass, "id"> & { id?: string })[] };
  wiring?: Partial<WiringSettings>;
  styles?: { text?: Partial<Record<string, Partial<TextStyle>>>; graphics?: Record<string, unknown>; reset?: boolean };
};

/** Change project settings (as the Project properties, Numbering, Wire numbering, Wiring and Global styles dialogs). */
export function updateSettings(doc: Doc, x: SettingsPatch): string {
  const done: string[] = [];
  if (x.drawingTitle !== undefined) {
    if (!x.drawingTitle.trim()) throw new EditError("The drawing title is empty");
    doc.meta.title = x.drawingTitle.trim();
    done.push(`drawing title "${doc.meta.title}"`);
  }
  if (x.properties) {
    doc.meta.props ??= {};
    for (const [k0, v] of Object.entries(x.properties)) {
      const k = k0.trim().replace(/^%/, "");
      if (!/^[\w.-]+$/.test(k)) throw new EditError(`Property name "${k0}": letters, digits, _ . - only`);
      if (v === "") delete doc.meta.props[k];
      else doc.meta.props[k] = v;
    }
    done.push(`properties ${Object.entries(x.properties).map(([k, v]) => `${k}=${v || "(removed)"}`).join("; ")}`);
  }
  if (x.revisions) ((doc.revisions = x.revisions.map(cleanRev)), done.push(`${x.revisions.length} revision rows`));
  if (x.addRevision) {
    doc.revisions = [...(doc.revisions ?? []), cleanRev(x.addRevision)];
    done.push(`revision ${x.addRevision.rev} added`);
  }
  if (x.numbering) {
    const n = x.numbering;
    if (n.rules) {
      for (const r of n.rules) {
        if (!["page", "project", "location"].includes(r.scope)) throw new EditError("rule scope must be page, project or location");
        if (!/\{n(:\d+)?\}/.test(r.format)) throw new EditError(`rule format "${r.format}" needs {n} (tokens {prefix} {n} {n:2} {page} {location})`);
      }
      doc.numbering.rules = n.rules.map((r) => ({ id: uid(), match: r.match || "*", prefix: r.prefix ?? "", scope: r.scope, format: r.format, start: r.start ?? 1 }));
      done.push(`${n.rules.length} numbering rule${n.rules.length === 1 ? "" : "s"}`);
    }
    if (n.autoOnPlace !== undefined) ((doc.numbering.autoOnPlace = n.autoOnPlace), done.push(`references given when placing: ${n.autoOnPlace ? "yes" : "no"}`));
    if (n.closeGapsOnDelete !== undefined) ((doc.numbering.closeGapsOnDelete = n.closeGapsOnDelete), done.push(`close gaps when deleting: ${n.closeGapsOnDelete ? "yes" : "no"}`));
  }
  if (x.wireNumbering) {
    const cur: WireNumbering = JSON.parse(JSON.stringify(wireNumberingOf(doc)));
    const w = x.wireNumbering;
    let next: WireNumbering = cur;
    if (w.preset && w.preset !== "custom" && w.preset !== cur.preset) next = { ...cur, ...PRESETS[w.preset] };
    const { classes, ...rest } = w;
    next = { ...next, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    if (w.format && !w.preset) next.preset = "custom";
    if (!/\{n(:\d+)?\}|\{col\}|\{row\}/.test(next.format)) throw new EditError(`format "${next.format}" needs a running number {n} / {n:3}, or {page}.{col}`);
    if (classes) {
      const letters = new Set<string>();
      next.classes = classes.map((c) => {
        const letter = c.letter.trim().toUpperCase();
        if (!letter) throw new EditError("Every supply needs a letter");
        if (RESERVED_CLASS_LETTERS.includes(letter)) throw new EditError(`"${letter}" is the terminal-strip letter (X1:3) — choose another supply letter`);
        if (letters.has(letter)) throw new EditError(`Letter ${letter} is used twice`);
        letters.add(letter);
        if (!["dc", "ac", "signal", "any"].includes(c.kind)) throw new EditError("supply kind must be dc, ac, signal or any");
        if (c.match) {
          try {
            new RegExp(c.match);
          } catch {
            throw new EditError(`match "${c.match}" is not a valid regular expression`);
          }
        }
        const id = c.id?.trim() || cur.classes.find((k) => k.letter === letter)?.id || letter.toLowerCase() + "-" + uid().slice(0, 4);
        return { id, letter, name: c.name || letter, kind: c.kind, ...(c.volts !== undefined ? { volts: c.volts } : {}), ...(c.match ? { match: c.match } : {}), ...(c.use ? { use: c.use } : {}) };
      });
      done.push(`supplies ${next.classes.map((c) => `${c.letter}=${c.name}`).join(", ")}`);
    }
    // default supplies for conductors of unknown voltage: must be supplies of the list
    for (const [k, kind] of [["defaultDc", "dc"], ["defaultAc", "ac"]] as const) {
      const v = next[k];
      if (!v || next.classes.some((c) => c.id === v)) continue;
      if (w[k] !== undefined) throw new EditError(`${k === "defaultDc" ? "default_dc" : "default_ac"} "${v}" is not a supply id (${next.classes.map((c) => c.id).join(", ")})`);
      const first = next.classes.find((c) => c.kind === kind)?.id;
      if (first) next[k] = first;
      else delete next[k];
    }
    doc.wireNumbering = next;
    const keys = Object.keys(rest).filter((k) => (rest as Record<string, unknown>)[k] !== undefined);
    if (keys.length) done.push(`wire numbering ${keys.map((k) => `${k}=${String((next as Record<string, unknown>)[k])}`).join("; ")}`);
  }
  if (x.wiring) {
    if (x.wiring.standard && !(x.wiring.standard in STANDARDS)) throw new EditError("standard must be iec, nfpa or jis");
    doc.wiring = { ...wiringOf(doc), ...Object.fromEntries(Object.entries(x.wiring).filter(([, v]) => v !== undefined)) } as WiringSettings;
    done.push(`wiring ${Object.entries(x.wiring).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join("; ")}`);
  }
  if (x.styles) {
    const st = x.styles;
    if (st.reset) ((doc.styles = {}), done.push("project styles reset to the template"));
    if (st.text) {
      const text = { ...(doc.styles.text ?? {}) } as Record<TextRole, Partial<TextStyle>>;
      for (const [r, v] of Object.entries(st.text)) {
        if (!(TEXT_ROLES as readonly string[]).includes(r)) throw new EditError(`Unknown text role "${r}" (roles: ${TEXT_ROLES.join(", ")})`);
        text[r as TextRole] = { ...(text[r as TextRole] ?? {}), ...v };
      }
      doc.styles = { ...doc.styles, text };
      done.push(`text styles ${Object.keys(st.text).join(", ")}`);
    }
    if (st.graphics) {
      const known = Object.keys(defaultStyles().graphics).concat("frame", "componentInfo", "componentInfoLayout");
      for (const k of Object.keys(st.graphics)) if (!known.includes(k)) throw new EditError(`Unknown graphics style "${k}" (${known.join(", ")})`);
      doc.styles = { ...doc.styles, graphics: deepMerge((doc.styles.graphics ?? {}) as GraphicStyles, st.graphics as never) };
      done.push(`graphics ${Object.keys(st.graphics).join(", ")}`);
    }
  }
  if (!done.length) throw new EditError("Nothing to change");
  return `Settings: ${done.join("; ")}`;
}

const cleanRev = (r: RevisionEntry): RevisionEntry => ({ rev: r.rev, date: r.date, description: r.description, ...(r.drawn ? { drawn: r.drawn } : {}), ...(r.checked ? { checked: r.checked } : {}), ...(r.approved ? { approved: r.approved } : {}) });

/* ------------------------------------------------------------------ */
/* Terminal strips                                                      */
/* ------------------------------------------------------------------ */

/** row key of a terminal given as its number, or "#id" of an unnumbered terminal */
function keyOf(view: StripView, t: string): string {
  const s = t.trim();
  if (s.startsWith("#")) {
    const k = s.slice(1).replace(/-/g, "").toLowerCase();
    const r = view.rows.find((x) => x.instances.some((i) => i.el.replace(/-/g, "").toLowerCase().startsWith(k)));
    if (!r) throw new EditError(`No terminal ${s} in ${view.tag || "(no strip)"}`);
    return r.key;
  }
  const r = view.rows.find((x) => x.num === s);
  if (!r) throw new EditError(`${view.tag || "(no strip)"} has no terminal ${s} (terminals: ${view.rows.map((x) => x.num ?? "#" + x.instances[0]?.el.slice(0, 8)).join(", ")})`);
  return r.key;
}

export function stripsText(doc: Doc, tag?: string): string {
  const views = collectStrips(doc).filter((v) => tag === undefined || v.tag === tag);
  if (!views.length) return tag ? `No terminal strip ${tag}` : "No terminal strips (terminals get a strip from references like X1:3)";
  const out: string[] = [];
  for (const v of views) {
    const s = v.strip;
    out.push(`${v.tag || "(terminals without a strip)"} — ${v.rows.length} terminals; reference ${v.tag}${v.sep}<n>${s?.description ? `; ${s.description}` : ""}${s?.location ? `; location ${s.location}` : ""}${s?.partNumber ? `; part ${s.partNumber}` : ""}${s?.manufacturer ? ` (${s.manufacturer})` : ""}`);
    out.push("  terminal | type | level | bridged to next | side 1 (top/left) | side 2 (bottom/right) | part | sheets | note");
    v.rows.forEach((r, i) => {
      out.push(`  ${r.num ?? `#${short(r.instances[0]?.el ?? "").slice(1)} (unnumbered)`} | ${terminalTypeLabel(r.type)}${r.spare ? " (spare, not drawn)" : ""} | ${r.row?.level ?? "-"} | ${r.row?.bridge && v.rows[i + 1] ? `→ ${v.rows[i + 1].num ?? "next"}` : "-"} | ${r.side1.join("; ") || "-"} | ${r.side2.join("; ") || "-"} | ${r.row?.partNumber ?? "-"} | ${[...new Set(r.instances.map((x) => x.sheet))].join(", ") || "-"} | ${r.row?.note ?? "-"}`);
    });
  }
  out.push(`Terminal types: ${TERMINAL_TYPES.map((t) => t.id).join(", ")}`);
  return out.join("\n");
}

export type StripEdit = {
  create?: { count: number; start?: number };
  rename?: string;
  separator?: ":" | "-" | ".";
  description?: string;
  location?: string;
  partNumber?: string;
  manufacturer?: string;
  /** terminals top to bottom (numbers; "#id" for unnumbered ones) */
  order?: string[];
  sortByNumber?: boolean;
  renumber?: { start?: number; step?: number; pad?: number; prefix?: string };
  rows?: { terminal: string; number?: string; type?: TerminalType | ""; level?: number | null; bridge?: boolean; partNumber?: string; note?: string }[];
  addSpares?: { count: number; after?: string };
  removeSpares?: string[];
  moveTerminals?: { terminals: string[]; toStrip: string };
  delete?: boolean;
};

/** The terminal strip editor: create, rename, order, number, terminal types / levels / bridges, spares, moving terminals between strips. */
export function editStrip(doc: Doc, tag: string, x: StripEdit): string {
  const done: string[] = [];
  const view = () => {
    const v = collectStrips(doc).find((s) => s.tag === tag);
    if (!v) throw new EditError(`No terminal strip ${tag} (strips: ${collectStrips(doc).map((s) => s.tag || "(none)").join(", ") || "none"}) — create it with create`);
    return v;
  };
  const wrap = <T,>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof EditError) throw e;
      throw new EditError((e as Error).message);
    }
  };
  if (x.create) {
    if (!tag.trim()) throw new EditError("Name the strip, e.g. X2");
    if (collectStrips(doc).some((v) => v.tag === tag)) throw new EditError(`Strip ${tag} exists already`);
    wrap(() => createStrip(doc, tag, x.create!.count, x.create!.start ?? 1));
    done.push(`created with ${x.create.count} terminals (spare until placed on a sheet with place_terminals)`);
  }
  if (x.delete) {
    const v = view();
    if (v.rows.some((r) => r.instances.length)) throw new EditError(`${tag} still has terminals drawn on sheets — delete those components or move them to another strip first`);
    deleteStrip(doc, tag);
    return `Deleted terminal strip ${tag}`;
  }
  if (x.order) {
    const v = view();
    wrap(() => setOrder(doc, tag, x.order!.map((t) => keyOf(v, t))));
    done.push("order set");
  }
  if (x.sortByNumber) {
    const v = view();
    wrap(() => setOrder(doc, tag, [...v.rows].sort((a, b) => (a.num && b.num ? natural.compare(a.num, b.num) : a.num ? -1 : 1)).map((r) => r.key)));
    done.push("sorted by number");
  }
  for (const r of x.rows ?? []) {
    const v = view();
    const key = keyOf(v, r.terminal);
    let num = v.rows.find((q) => q.key === key)?.num ?? null;
    if (r.number?.trim()) {
      if (v.rows.some((q) => q.num === r.number!.trim() && q.key !== key)) throw new EditError(`${tag} already has a terminal ${r.number.trim()}`);
      wrap(() => setTerminalNumber(doc, tag, key, r.number!));
      num = r.number.trim();
    }
    if (!num) throw new EditError(`Terminal ${r.terminal} has no number yet — give it one with number`);
    const patch: Partial<StripRow> = {};
    if (r.type !== undefined) {
      if (r.type && !TERMINAL_TYPES.some((t) => t.id === r.type)) throw new EditError(`type must be one of ${TERMINAL_TYPES.map((t) => t.id).join(", ")}`);
      patch.type = r.type || undefined;
    }
    if (r.level !== undefined) patch.level = r.level ?? undefined;
    if (r.bridge !== undefined) patch.bridge = r.bridge;
    if (r.partNumber !== undefined) patch.partNumber = r.partNumber;
    if (r.note !== undefined) patch.note = r.note;
    if (Object.keys(patch).length) wrap(() => setRow(doc, tag, num!, patch));
    done.push(`terminal ${num}${r.number ? ` (was ${r.terminal})` : ""}: ${Object.entries(patch).map(([k, val]) => `${k}=${val === undefined || val === "" ? "(cleared)" : val}`).join(", ") || "numbered"}`);
  }
  if (x.renumber) {
    const v = view();
    wrap(() => renumberStrip(doc, tag, v.rows.map((r) => r.key), x.renumber));
    done.push(`renumbered from ${x.renumber.prefix ?? ""}${x.renumber.start ?? 1} step ${x.renumber.step ?? 1}`);
  }
  if (x.addSpares) {
    const v = view();
    const after = x.addSpares.after ? v.rows.find((r) => r.key === keyOf(v, x.addSpares!.after!))?.num ?? undefined : undefined;
    const made: string[] = [];
    let at = after;
    for (let i = 0; i < Math.min(200, x.addSpares.count); i++) {
      const n = wrap(() => addSpare(doc, tag, at));
      made.push(n);
      at = n;
    }
    done.push(`spare terminals ${made.join(", ")}`);
  }
  for (const t of x.removeSpares ?? []) {
    const v = view();
    const r = v.rows.find((q) => q.num === t.trim());
    if (!r) throw new EditError(`${tag} has no terminal ${t}`);
    if (r.instances.length) throw new EditError(`Terminal ${t} is drawn on sheet ${r.instances[0].sheet} — delete the component instead`);
    wrap(() => removeRow(doc, tag, r.num!));
    done.push(`removed spare ${t}`);
  }
  if (x.moveTerminals) {
    const v = view();
    const to = x.moveTerminals.toStrip.trim();
    if (!to) throw new EditError("Give the strip to move to");
    const keys = x.moveTerminals.terminals.map((t) => keyOf(v, t));
    if (!tag) done.push(`${wrap(() => assignToStrip(doc, tag, keys, to))} terminals put into ${to}`);
    else {
      const nums = keys.map((k) => wrap(() => moveToStrip(doc, tag, k, to)));
      done.push(`moved to ${to} as ${nums.map((n) => `${to}:${n}`).join(", ")}`);
    }
  }
  const strip = stripOf(doc, tag);
  const props: [keyof StripEdit, "description" | "location" | "partNumber" | "manufacturer"][] = [["description", "description"], ["location", "location"], ["partNumber", "partNumber"], ["manufacturer", "manufacturer"]];
  const sp: Record<string, string> = {};
  for (const [k, f] of props) if (x[k] !== undefined) sp[f] = String(x[k]);
  if (x.separator) sp.sep = x.separator;
  if (x.rename?.trim() && x.rename.trim() !== tag) sp.tag = x.rename.trim();
  if (Object.keys(sp).length) {
    view();
    wrap(() => setStrip(doc, tag, sp));
    done.push(Object.entries(sp).map(([k, v]) => (k === "tag" ? `renamed to ${v} (terminal references follow)` : `${k}=${v || "(cleared)"}`)).join(", "));
  }
  if (!done.length) throw new EditError("Nothing to change");
  void strip;
  return `Terminal strip ${tag}: ${done.join("; ")}`;
}

/**
 * Draw terminals of a strip on a sheet (side by side, or one under the other), at a cell / point or
 * in a free area below what is drawn. Default: the strip's terminals that are not drawn yet.
 */
export function placeStripTerminals(doc: Doc, tag: string, pageRef: string, o: { terminals?: string[]; direction?: "h" | "v"; at?: { cell?: string; x?: number; y?: number }; def?: ElementDef }): string {
  const v = collectStrips(doc).find((s) => s.tag === tag);
  if (!v) throw new EditError(`No terminal strip ${tag}`);
  const nums = o.terminals?.length ? o.terminals.map((t) => t.trim()) : v.rows.filter((r) => r.num && !r.instances.length).map((r) => r.num!);
  if (!nums.length) throw new EditError(`Every terminal of ${tag} is drawn already — give terminals to draw them again`);
  const pg = getPage(doc, findPage(doc, pageRef).id);
  const def = o.def ?? terminalSymbols(doc, tag)[0];
  const at = o.at ? positionOf(doc, pg, o.at) : undefined;
  const ids = placeTerminals(doc, pg, tag, nums, def, { dir: o.direction, at, newElement: (d, p, df, pt) => newElement(d, p, df, pt) });
  const first = pg.elements.find((e) => e.id === ids[0]);
  return `Drew ${ids.length} terminal${ids.length === 1 ? "" : "s"} of ${tag} (${nums[0]}${nums.length > 1 ? `–${nums[nums.length - 1]}` : ""}) on page ${sheetNo(doc, pg)}${first ? ` from ${gridRef(doc, pg, first) || `(${first.x}, ${first.y})`}` : ""} with symbol "${def.name}"; connect them with connect_pins / draw_wire`;
}

/* ------------------------------------------------------------------ */
/* Cables and reports                                                   */
/* ------------------------------------------------------------------ */

export function cablesText(doc: Doc): string {
  const used = new Map<string, { core: string; wire: string; page: number }[]>();
  for (const x of allWires(doc)) if (x.w.cable) (used.get(x.w.cable) ?? used.set(x.w.cable, []).get(x.w.cable)!).push({ core: x.w.core ?? "?", wire: `${x.w.label || "·"} ${short(x.w.id)}`, page: sheetNo(doc, x.page) });
  const tags = [...new Set([...(doc.cables ?? []).map((c) => c.tag), ...used.keys()])].sort(natural.compare);
  if (!tags.length) return "No cables. Create one with set_cable (cores, type, section) and put wires into it.";
  return tags
    .map((t) => {
      const c = (doc.cables ?? []).find((x) => x.tag === t);
      const ws = used.get(t) ?? [];
      const head = c ? `${t} — ${c.type || cableDesignation(c)}${c.section ? `, ${c.section}` : ""}${c.shield ? ", shielded" : ""}${c.length ? `, ${c.length}` : ""}${c.note ? ` (${c.note})` : ""}` : `${t} — wires say this cable, but it is not defined (set_cable creates it)`;
      const cores = c ? c.cores.map((k) => `${k.name}${k.color && k.color !== k.name ? `(${k.color})` : ""}: ${ws.filter((w) => w.core === k.name).map((w) => `${w.wire}@${w.page}`).join(", ") || "free"}`) : [];
      const stray = ws.filter((w) => !c?.cores.some((k) => k.name === w.core));
      return [head, ...cores.map((x) => "  " + x), ...(stray.length ? [`  without a valid core: ${stray.map((w) => `${w.wire}@${w.page} (core ${w.core})`).join(", ")}`] : [])].join("\n");
    })
    .join("\n");
}

export type ReportKind = "bom" | "wire_list" | "terminal_plan" | "cable_list";

const csvCell = (v: string | number) => {
  const s = String(v ?? "");
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** table reports: header + rows */
export function reportTable(doc: Doc, kind: ReportKind, o: { grouping?: BomGrouping; pages?: string[] } = {}): { title: string; header: string[]; rows: (string | number)[][] } {
  const pages = o.pages?.length ? o.pages.map((p) => findPage(doc, p)) : undefined;
  if (kind === "bom") {
    const bom = buildBom(doc, { pages, grouping: o.grouping });
    const cols = bomColumns(bom);
    return { title: `Bill of materials — ${bom.rows.length} lines, ${bom.components} components${bom.missingPart ? `, ${bom.missingPart} lines without a part number` : ""}${bom.cables.length ? `, ${bom.cables.length} cables` : ""}`, header: cols.map((c) => c.label), rows: [...bom.rows.map((r) => cols.map((c) => bomCell(r, c.key))), ...bom.cables.map((c) => ["cable", 1, "pcs", c.tag, c.type || `${c.cores} cores`, c.section, "", "", "", "", ""])] };
  }
  if (kind === "terminal_plan") {
    const rows: (string | number)[][] = [];
    for (const v of collectStrips(doc))
      v.rows.forEach((r, i) => rows.push([v.tag, r.num ?? "(unnumbered)", `${terminalTypeLabel(r.type)}${r.spare ? " (spare)" : ""}`, r.row?.level ?? "", r.row?.bridge && v.rows[i + 1] ? `→ ${v.rows[i + 1].num ?? "next"}` : "", r.side1.join("; "), r.side2.join("; "), r.row?.partNumber ?? v.strip?.partNumber ?? "", [...new Set(r.instances.map((x) => x.sheet))].join(", "), r.row?.note ?? ""]));
    return { title: `Terminal plan — ${rows.length} terminals`, header: ["Strip", "Terminal", "Type", "Level", "Bridge", "Side 1", "Side 2", "Part number", "Sheets", "Note"], rows };
  }
  if (kind === "cable_list") {
    const rows: (string | number)[][] = [];
    for (const c of doc.cables ?? []) {
      const ws = allWires(doc).filter((x) => x.w.cable === c.tag);
      for (const k of c.cores) {
        const w = ws.find((x) => x.w.core === k.name);
        rows.push([c.tag, c.type || cableDesignation(c), k.name, k.color ?? "", w ? w.w.label ?? "" : "", w ? endName(doc, w, "a") : "", w ? endName(doc, w, "b") : "", w ? sheetNo(doc, w.page) : ""]);
      }
    }
    return { title: `Cable list — ${(doc.cables ?? []).length} cables`, header: ["Cable", "Type", "Core", "Colour", "Wire", "From", "To", "Sheet"], rows };
  }
  // wire list
  const list = allWires(doc).filter((x) => !pages || pages.includes(x.page));
  return {
    title: `Wire list — ${list.length} wires`,
    header: ["Wire", "From", "To", "Potential", "Use", "Colour", "Section", "Cable", "Core", "Sheet", "Cell", "Id"],
    rows: list.map((x) => {
      const i = wireInfo(doc, x.w);
      return [x.w.label ?? "", endName(doc, x, "a"), endName(doc, x, "b"), wirePot(x.w) ?? "", wireUse(x.w) ?? "", i.color ?? "", i.section ?? "", x.w.cable ?? "", x.w.core ?? "", sheetNo(doc, x.page), gridRef(doc, x.page, x.w.pts[Math.floor(x.w.pts.length / 2)]) ?? "", short(x.w.id)];
    }),
  };
}

function endName(doc: Doc, x: { w: import("@/core/model").Wire; page: import("@/core/model").Page }, end: "a" | "b") {
  const e = x.w[end];
  if (e.k === "free") return "(free end)";
  if (e.k === "junction") return "(junction)";
  const el = x.page.elements.find((q) => q.id === e.el);
  const def = el ? doc.defs[el.defId] : undefined;
  const pin = def?.pins.find((p) => p.id === e.pin);
  return el ? `${refOf(doc, { e: el, def })}:${pin?.number || pin?.name || "?"}` : "?";
}

export function reportText(t: { title: string; header: string[]; rows: (string | number)[][] }, limit = 1500) {
  return [t.title, t.header.join(" | "), ...t.rows.slice(0, limit).map((r) => r.map((c) => String(c ?? "").replace(/\s+/g, " ")).join(" | ")), ...(t.rows.length > limit ? [`… ${t.rows.length - limit} more rows (export_file for all)`] : [])].join("\n");
}
export function reportCsv(t: { header: string[]; rows: (string | number)[][] }) {
  return "\ufeff" + [t.header.map(csvCell).join(","), ...t.rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}
export { compactRefs };
