import type { Doc, ElemInst, Page, Wire } from "./model";
import { stableStringify } from "./stable-json";

export type ChangeKind = "added" | "removed" | "changed" | "moved";
export type Change = { kind: ChangeKind; area: "page" | "element" | "wire" | "text" | "junction" | "style" | "titleblock" | "definition" | "project"; pageId?: string; id?: string; label: string; details?: string[] };
export type DocDiff = { changes: Change[]; tintA: Map<string, ChangeKind>; tintB: Map<string, ChangeKind>; summary: Record<ChangeKind, number> };

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const elName = (doc: Doc, e: ElemInst) => e.info.label || doc.defs[e.defId]?.name || "element";

function diffObj(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[k], b[k])) out.push(`${prefix}${k}: ${fmtV(a[k])} → ${fmtV(b[k])}`);
  return out;
}
const fmtV = (v: unknown) => (v === undefined || v === "" ? "∅" : typeof v === "object" ? "…" : String(v));

export function diffDocs(A: Doc, B: Doc): DocDiff {
  const changes: Change[] = [];
  const tintA = new Map<string, ChangeKind>(), tintB = new Map<string, ChangeKind>();
  if (A.meta.title !== B.meta.title) changes.push({ kind: "changed", area: "project", label: "Project title", details: [`${A.meta.title} → ${B.meta.title}`] });
  const pd = diffObj(A.meta.props, B.meta.props);
  if (pd.length) changes.push({ kind: "changed", area: "project", label: "Project properties", details: pd });
  if (!same(A.styles, B.styles) || !same(A.baseStyles, B.baseStyles)) changes.push({ kind: "changed", area: "style", label: "Project styles", details: diffStyles(A, B) });
  if (!same(A.numbering, B.numbering)) changes.push({ kind: "changed", area: "project", label: "Numbering rules" });

  for (const id of new Set([...Object.keys(A.defs), ...Object.keys(B.defs)])) {
    const a = A.defs[id], b = B.defs[id];
    if (a && b && !same({ p: a.prims, n: a.pins, i: a.info }, { p: b.prims, n: b.pins, i: b.info })) changes.push({ kind: "changed", area: "definition", id, label: `Element definition ${b.name}` });
  }

  const pa = new Map(A.pages.map((p) => [p.id, p]));
  const pb = new Map(B.pages.map((p) => [p.id, p]));
  for (const [id, p] of pa) if (!pb.has(id)) changes.push({ kind: "removed", area: "page", pageId: id, label: `Page "${p.title}"` });
  for (const [id, p] of pb) if (!pa.has(id)) changes.push({ kind: "added", area: "page", pageId: id, label: `Page "${p.title}"` });
  const orderA = [...A.pages].sort((x, y) => x.order - y.order).map((p) => p.id).filter((i) => pb.has(i));
  const orderB = [...B.pages].sort((x, y) => x.order - y.order).map((p) => p.id).filter((i) => pa.has(i));
  if (!same(orderA, orderB)) changes.push({ kind: "changed", area: "page", label: "Page order changed" });

  for (const [id, b] of pb) {
    const a = pa.get(id);
    if (!a) {
      for (const e of b.elements) tintB.set(e.id, "added");
      for (const w of b.wires) tintB.set(w.id, "added");
      continue;
    }
    diffPage(A, B, a, b, changes, tintA, tintB);
  }
  const summary: Record<ChangeKind, number> = { added: 0, removed: 0, changed: 0, moved: 0 };
  for (const c of changes) summary[c.kind]++;
  return { changes, tintA, tintB, summary };
}

function diffStyles(A: Doc, B: Doc): string[] {
  const out: string[] = [];
  const ta = (A.styles.text ?? {}) as Record<string, object>, tb = (B.styles.text ?? {}) as Record<string, object>;
  for (const r of new Set([...Object.keys(ta), ...Object.keys(tb)])) if (!same(ta[r], tb[r])) out.push(`text.${r}`);
  if (!same(A.styles.graphics, B.styles.graphics)) out.push("graphics");
  if (!same(A.baseStyles, B.baseStyles)) out.push("organization template");
  return out;
}

function diffPage(A: Doc, B: Doc, a: Page, b: Page, changes: Change[], tintA: Map<string, ChangeKind>, tintB: Map<string, ChangeKind>) {
  const P = b.title;
  if (a.title !== b.title) changes.push({ kind: "changed", area: "page", pageId: b.id, label: `Page renamed`, details: [`${a.title} → ${b.title}`] });
  const md = [...diffObj(a.meta, b.meta), ...(same(a.border, b.border) ? [] : ["border"])];
  if (md.length) changes.push({ kind: "changed", area: "page", pageId: b.id, label: `${P}: page settings`, details: md });
  const tbd = diffObj(a.titleBlock.fields, b.titleBlock.fields);
  if (tbd.length || a.titleBlock.template !== b.titleBlock.template) changes.push({ kind: "changed", area: "titleblock", pageId: b.id, label: `${P}: title block`, details: tbd });

  const ea = new Map(a.elements.map((e) => [e.id, e]));
  const eb = new Map(b.elements.map((e) => [e.id, e]));
  for (const [id, e] of ea)
    if (!eb.has(id)) {
      changes.push({ kind: "removed", area: "element", pageId: b.id, id, label: `${P}: ${elName(A, e)}` });
      tintA.set(id, "removed");
    }
  for (const [id, e] of eb) {
    const o = ea.get(id);
    if (!o) {
      changes.push({ kind: "added", area: "element", pageId: b.id, id, label: `${P}: ${elName(B, e)}` });
      tintB.set(id, "added");
      continue;
    }
    const det: string[] = [];
    if (o.defId !== e.defId) det.push(`type: ${A.defs[o.defId]?.name} → ${B.defs[e.defId]?.name}`);
    det.push(...diffObj(o.info, e.info));
    if (o.rot !== e.rot || o.mirror !== e.mirror) det.push("orientation");
    if (!same(o.texts, e.texts)) det.push("texts / styles");
    const moved = o.x !== e.x || o.y !== e.y;
    if (det.length) {
      changes.push({ kind: "changed", area: "element", pageId: b.id, id, label: `${P}: ${elName(B, e)}`, details: moved ? [...det, `moved (${o.x},${o.y}) → (${e.x},${e.y})`] : det });
      tintB.set(id, "changed");
      tintA.set(id, "changed");
    } else if (moved) {
      changes.push({ kind: "moved", area: "element", pageId: b.id, id, label: `${P}: ${elName(B, e)}`, details: [`(${o.x},${o.y}) → (${e.x},${e.y})`] });
      tintB.set(id, "moved");
      tintA.set(id, "moved");
    }
  }
  const wa = new Map(a.wires.map((w) => [w.id, w]));
  const wb = new Map(b.wires.map((w) => [w.id, w]));
  const wl = (w: Wire) => (w.label ? `wire ${w.label}` : "wire");
  for (const [id, w] of wa)
    if (!wb.has(id)) {
      changes.push({ kind: "removed", area: "wire", pageId: b.id, id, label: `${P}: ${wl(w)}` });
      tintA.set(id, "removed");
    }
  for (const [id, w] of wb) {
    const o = wa.get(id);
    if (!o) {
      changes.push({ kind: "added", area: "wire", pageId: b.id, id, label: `${P}: ${wl(w)}` });
      tintB.set(id, "added");
      continue;
    }
    const det: string[] = [];
    if (!same(o.a, w.a) || !same(o.b, w.b)) det.push("connection changed");
    if ((o.label ?? "") !== (w.label ?? "")) det.push(`label: ${o.label ?? "∅"} → ${w.label ?? "∅"}`);
    if (!same(o.override, w.override) || o.bus !== w.bus) det.push("style");
    const geo = !same(o.pts, w.pts);
    if (det.length) {
      changes.push({ kind: "changed", area: "wire", pageId: b.id, id, label: `${P}: ${wl(w)}`, details: det });
      tintB.set(id, "changed");
      tintA.set(id, "changed");
    } else if (geo) {
      changes.push({ kind: "moved", area: "wire", pageId: b.id, id, label: `${P}: ${wl(w)} rerouted` });
      tintB.set(id, "moved");
      tintA.set(id, "moved");
    }
  }
  const ta = new Map(a.texts.map((t) => [t.id, t]));
  const tb = new Map(b.texts.map((t) => [t.id, t]));
  for (const [id, t] of ta)
    if (!tb.has(id)) {
      changes.push({ kind: "removed", area: "text", pageId: b.id, id, label: `${P}: text "${t.text.slice(0, 30)}"` });
      tintA.set(id, "removed");
    }
  for (const [id, t] of tb) {
    const o = ta.get(id);
    if (!o) {
      changes.push({ kind: "added", area: "text", pageId: b.id, id, label: `${P}: text "${t.text.slice(0, 30)}"` });
      tintB.set(id, "added");
    } else if (!same(o, t)) {
      changes.push({ kind: "changed", area: "text", pageId: b.id, id, label: `${P}: text "${t.text.slice(0, 30)}"` });
      tintB.set(id, "changed");
    }
  }
  const ja = new Set(a.junctions.map((j) => j.id)), jb = new Set(b.junctions.map((j) => j.id));
  const jadd = [...jb].filter((x) => !ja.has(x)).length, jrem = [...ja].filter((x) => !jb.has(x)).length;
  if (jadd) changes.push({ kind: "added", area: "junction", pageId: b.id, label: `${P}: ${jadd} junction(s)` });
  if (jrem) changes.push({ kind: "removed", area: "junction", pageId: b.id, label: `${P}: ${jrem} junction(s)` });
}
