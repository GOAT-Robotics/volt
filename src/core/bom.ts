/**
 * Bill of materials: the parts drawn in a project, read from each component's information
 * (name, rating, part number, manufacturer, supplier, quantity, unit, location).
 *
 * Counting rules
 * - One component = one reference. Instances that share a reference (a relay coil and its
 *   contacts, a terminal shown on two pages) are one part; unreferenced instances count one each.
 * - Slave elements (contacts of a master), folio-report arrows, Volt junctions, hidden
 *   instances and pure graphics (no pins, no reference, no part number) are left out.
 * - A component is left out when its `bom` field is "no" (Inspector → Bill of materials).
 * - The `quantity` field multiplies (e.g. 10 terminals on one strip reference, 2.5 m of cable duct).
 */
import type { Cable, Doc, ElemInst, ElementDef, Page } from "./model";
import { buildXlsx, type XlsxSheet } from "./xlsx";
import { terminalBomInfo, terminalTypeLabel } from "./terminals";

export type BomGrouping = "part" | "location" | "component";

export type BomRow = {
  item: number;
  qty: number;
  unit: string;
  refs: string[];
  name: string;
  rating: string;
  partNumber: string;
  manufacturer: string;
  supplier: string;
  location: string;
  symbol: string;
  /** 1-based sheet numbers the parts appear on */
  sheets: number[];
  /** placed components and library elements behind this line (to find datasheets) */
  ids?: string[];
  libraryIds?: string[];
  /** link to the datasheet (filled in by the exporter when documents exist) */
  datasheet?: string;
};

export type BomCableRow = { tag: string; type: string; cores: number; section: string; shield: boolean; length: string; note: string };

export type Bom = {
  rows: BomRow[];
  cables: BomCableRow[];
  /** components counted (after merging instances by reference) */
  components: number;
  /** lines without a part number */
  missingPart: number;
  /** components left out with bom = no */
  excluded: number;
};

export const BOM_EXCLUDE_VALUES = ["no", "false", "0", "exclude", "excluded", "n"];

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const naturalCompare = (a: string, b: string) => natural.compare(a, b);

function isPart(def: ElementDef | undefined, e: ElemInst, val: (k: string) => string): boolean {
  if (!def || e.hidden) return false;
  if (def.name === "volt_junction") return false;
  if (def.linkType === "slave" || def.linkType === "next_report" || def.linkType === "previous_report") return false;
  if (!def.pins.length && !e.info.label && !val("manufacturer_reference")) return false;
  return true;
}

export function isBomExcluded(e: ElemInst): boolean {
  return BOM_EXCLUDE_VALUES.includes((e.info.bom ?? "").trim().toLowerCase());
}

function parseQty(s: string): number {
  const n = Number(String(s).replace(",", ".").trim());
  return Number.isFinite(n) && n > 0 ? n : 1;
}

type Comp = { ref: string; def: ElementDef; info: Record<string, string>; sheets: Set<number>; qty: number; ids?: string[] };

/** Build the bill of materials for the given pages (default: every page that isn't archived). */
export function buildBom(doc: Doc, opts: { pages?: Page[]; grouping?: BomGrouping } = {}): Bom {
  const grouping = opts.grouping ?? "part";
  const ordered = [...doc.pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const sheetNo = new Map(ordered.map((p, i) => [p.id, i + 1]));
  const pages = opts.pages ?? ordered;
  const byRef = new Map<string, Comp>();
  const loose: Comp[] = [];
  let excluded = 0;
  const excludedRefs = new Set<string>();
  for (const page of pages) {
    const sheet = sheetNo.get(page.id) ?? 0;
    for (const e of page.elements) {
      const def = doc.defs[e.defId];
      const val = (k: string) => (e.info[k] ?? def?.info[k] ?? "").trim();
      if (!def || !isPart(def, e, val)) continue;
      const ref = (e.info.label ?? "").trim();
      if (isBomExcluded(e)) {
        if (!ref) excluded++;
        else excludedRefs.add(ref);
        continue;
      }
      const info: Record<string, string> = {};
      for (const k of ["description", "rating", "manufacturer_reference", "manufacturer", "supplier", "quantity", "unity", "location"]) {
        const v = val(k);
        if (v) info[k] = v;
      }
      if (!ref) {
        loose.push({ ref: "", def, info, sheets: new Set([sheet]), qty: parseQty(info.quantity ?? ""), ids: [e.id] });
        continue;
      }
      const cur = byRef.get(ref);
      if (!cur) {
        byRef.set(ref, { ref, def, info, sheets: new Set([sheet]), qty: parseQty(info.quantity ?? ""), ids: [e.id] });
      } else {
        cur.sheets.add(sheet);
        cur.ids?.push(e.id);
        // the instance carrying the most information describes the part (e.g. the coil, not a contact)
        for (const [k, v] of Object.entries(info)) if (!cur.info[k]) cur.info[k] = v;
        if (info.quantity && !cur.info.quantity) cur.qty = parseQty(info.quantity);
        if (def.pins.length > cur.def.pins.length && !cur.info.manufacturer_reference) cur.def = def;
      }
    }
  }
  // a reference excluded on any instance is excluded everywhere
  for (const r of excludedRefs) {
    byRef.delete(r);
    excluded++;
  }
  const comps = [...byRef.values(), ...loose];
  // terminal strips: default part numbers per terminal, and spare terminals on the rail
  if (doc.terminalStrips?.length && pages.length === ordered.length) {
    const t = terminalBomInfo(doc);
    for (const c of comps) {
      const p = t.partByRef.get(c.ref);
      if (!p) continue;
      if (p.partNumber && !c.info.manufacturer_reference) c.info.manufacturer_reference = p.partNumber;
      if (p.manufacturer && !c.info.manufacturer) c.info.manufacturer = p.manufacturer;
    }
    for (const sp of t.spares) {
      const def = { id: `spare-terminal:${sp.type}`, name: "terminal", names: { en: `Terminal (${terminalTypeLabel(sp.type).toLowerCase()})` }, pins: [], info: {} } as unknown as ElementDef;
      const info: Record<string, string> = { description: `Terminal, ${terminalTypeLabel(sp.type).toLowerCase()} (spare)` };
      if (sp.partNumber) info.manufacturer_reference = sp.partNumber;
      if (sp.manufacturer) info.manufacturer = sp.manufacturer;
      comps.push({ ref: sp.ref, def, info, sheets: new Set(), qty: 1 });
    }
  }

  const symbolName = (d: ElementDef) => d.names.en ?? Object.values(d.names)[0] ?? d.name;
  const rowOf = (c: Comp): Omit<BomRow, "item"> => ({
    qty: c.qty,
    unit: c.info.unity ?? "pcs",
    refs: c.ref ? [c.ref] : [],
    name: c.info.description ?? symbolName(c.def),
    rating: c.info.rating ?? "",
    partNumber: c.info.manufacturer_reference ?? "",
    manufacturer: c.info.manufacturer ?? "",
    supplier: c.info.supplier ?? "",
    location: c.info.location ?? "",
    symbol: symbolName(c.def),
    sheets: [...c.sheets].filter(Boolean).sort((a, b) => a - b),
    ids: c.ids ?? [],
    libraryIds: c.def.source?.libraryElementId ? [c.def.source.libraryElementId] : [],
  });

  let rows: Omit<BomRow, "item">[];
  if (grouping === "component") {
    rows = comps.map(rowOf);
  } else {
    const groups = new Map<string, Omit<BomRow, "item">>();
    for (const c of comps) {
      const r = rowOf(c);
      const part = r.partNumber
        ? `pn|${r.manufacturer.toLowerCase()}|${r.partNumber.toLowerCase()}`
        : `sym|${c.def.id}|${r.name.toLowerCase()}|${r.rating.toLowerCase()}`;
      const key = `${grouping === "location" ? r.location.toLowerCase() : ""}#${part}#${r.unit.toLowerCase()}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, r);
        continue;
      }
      g.qty += r.qty;
      g.refs.push(...r.refs);
      g.sheets = [...new Set([...g.sheets, ...r.sheets])].sort((a, b) => a - b);
      g.ids = [...(g.ids ?? []), ...(r.ids ?? [])];
      g.libraryIds = [...new Set([...(g.libraryIds ?? []), ...(r.libraryIds ?? [])])];
      if (grouping === "part" && r.location && !g.location.split(", ").includes(r.location)) g.location = g.location ? `${g.location}, ${r.location}` : r.location;
      for (const k of ["rating", "supplier", "manufacturer"] as const) if (!g[k] && r[k]) g[k] = r[k];
    }
    rows = [...groups.values()];
  }
  for (const r of rows) {
    r.refs.sort(naturalCompare);
    r.qty = Math.round(r.qty * 1000) / 1000;
  }
  const firstRef = (r: Omit<BomRow, "item">) => r.refs[0] ?? "￿";
  rows.sort((a, b) =>
    (grouping === "location" ? naturalCompare(a.location || "￿", b.location || "￿") : 0) ||
    naturalCompare(firstRef(a).replace(/\d.*$/, ""), firstRef(b).replace(/\d.*$/, "")) ||
    naturalCompare(firstRef(a), firstRef(b)) ||
    naturalCompare(a.name, b.name),
  );

  const cables: BomCableRow[] = (doc.cables ?? [])
    .map((c: Cable) => ({ tag: c.tag, type: c.type ?? "", cores: c.cores.length, section: c.section ?? "", shield: !!c.shield, length: c.length ?? "", note: c.note ?? "" }))
    .sort((a, b) => naturalCompare(a.tag, b.tag));

  return {
    rows: rows.map((r, i) => ({ item: i + 1, ...r })),
    cables,
    components: comps.length,
    missingPart: rows.filter((r) => !r.partNumber).length,
    excluded,
  };
}

/** Compress a sorted list of references: K1, K2, K3, K5 → "K1–K3, K5". */
export function compactRefs(refs: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < refs.length) {
    const m = /^(.*?)(\d+)$/.exec(refs[i]);
    let j = i;
    if (m) {
      while (j + 1 < refs.length) {
        const n = /^(.*?)(\d+)$/.exec(refs[j + 1]);
        if (!n || n[1] !== m[1] || Number(n[2]) !== Number(m[2]) + (j + 1 - i)) break;
        j++;
      }
    }
    out.push(j - i >= 2 ? `${refs[i]}–${refs[j]}` : refs.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return out.join(", ");
}

export const BOM_COLUMNS = [
  { key: "item", label: "Item" },
  { key: "qty", label: "Qty" },
  { key: "unit", label: "Unit" },
  { key: "refs", label: "Reference" },
  { key: "name", label: "Name" },
  { key: "rating", label: "Rating" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "partNumber", label: "Part number" },
  { key: "supplier", label: "Supplier" },
  { key: "location", label: "Location" },
  { key: "sheets", label: "Sheets" },
] as const;

type BomKey = (typeof BOM_COLUMNS)[number]["key"] | "datasheet";
/** the columns of a BOM (Datasheet only when links exist) */
export function bomColumns(bom: Bom): { key: BomKey; label: string }[] {
  return bom.rows.some((r) => r.datasheet) ? [...BOM_COLUMNS, { key: "datasheet", label: "Datasheet" }] : [...BOM_COLUMNS];
}

/** fill in datasheet links: by placed component, library element or part number */
export function attachDatasheets(bom: Bom, idx: { byElement: Record<string, string>; byLibrary: Record<string, string>; byPart: Record<string, string> }) {
  for (const r of bom.rows) r.datasheet = r.ids?.map((i) => idx.byElement[i]).find(Boolean) ?? r.libraryIds?.map((i) => idx.byLibrary[i]).find(Boolean) ?? (r.partNumber ? idx.byPart[r.partNumber] : undefined);
  return bom;
}

export function bomCell(r: BomRow, key: BomKey): string | number {
  if (key === "datasheet") return r.datasheet ?? "";
  if (key === "refs") return compactRefs(r.refs);
  if (key === "sheets") return r.sheets.join(", ");
  return r[key];
}

export const CABLE_COLUMNS = [
  { key: "tag", label: "Cable" },
  { key: "type", label: "Type / part" },
  { key: "cores", label: "Cores" },
  { key: "section", label: "Section" },
  { key: "shield", label: "Shielded" },
  { key: "length", label: "Length" },
  { key: "note", label: "Note" },
] as const;

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV (UTF-8 with BOM so Excel reads accents and mm² correctly). */
export function bomToCsv(bom: Bom): string {
  const cols = bomColumns(bom);
  const lines = [cols.map((c) => c.label).join(",")];
  for (const r of bom.rows) lines.push(cols.map((c) => csvCell(bomCell(r, c.key))).join(","));
  if (bom.cables.length) {
    lines.push("", "Cables", CABLE_COLUMNS.map((c) => c.label).join(","));
    for (const c of bom.cables) lines.push(CABLE_COLUMNS.map((k) => csvCell(k.key === "shield" ? (c.shield ? "yes" : "no") : c[k.key])).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Excel workbook: "Bill of materials" sheet (+ "Cables" when the project defines cables). */
export function bomToXlsx(bom: Bom, meta: { title: string; subtitle?: string }): Uint8Array {
  const sheets: XlsxSheet[] = [
    {
      name: "Bill of materials",
      title: [meta.title, ...(meta.subtitle ? [meta.subtitle] : [])],
      header: bomColumns(bom).map((c): string => c.label),
      rows: bom.rows.map((r) => bomColumns(bom).map((c) => bomCell(r, c.key))),
      widths: [6, 7, 6, 28, 30, 20, 18, 22, 16, 14, 10, 50],
    },
  ];
  if (bom.cables.length)
    sheets.push({
      name: "Cables",
      title: [meta.title],
      header: CABLE_COLUMNS.map((c) => c.label),
      rows: bom.cables.map((c) => CABLE_COLUMNS.map((k) => (k.key === "shield" ? (c.shield ? "yes" : "no") : c[k.key]))),
      widths: [10, 34, 7, 12, 9, 10, 30],
    });
  return buildXlsx(sheets, { title: meta.title });
}
