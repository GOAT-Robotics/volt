import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Doc, ElemInst, ElementDef, Page, Prim, Pt, Wire } from "../model";
import { newDoc } from "../doc";
import { toScene } from "../geometry";
import {
  exportQet,
  importQet,
  JUNCTION_DEF_PATH,
  parseCols,
  parseElmt,
  parseRows,
  parseTitleBlockTemplate,
  primsBBox,
  qetAutoPath,
  QET_MARGIN,
  serializeElmt,
  serializeTitleBlockTemplate,
  titleBlockColumnWidths,
  validateQet,
} from "./index";
import { parseXml, subChildren, children, child, attr, serializeXml } from "./xml";

const FIX = path.join(__dirname, "__fixtures__");
const elmtFiles = readdirSync(path.join(FIX, "elements")).filter((f) => f.endsWith(".elmt"));
const qetFiles = readdirSync(path.join(FIX, "projects")).filter((f) => f.endsWith(".qet"));
const readElmt = (f: string) => readFileSync(path.join(FIX, "elements", f), "utf8");
const readQet = (f: string) => readFileSync(path.join(FIX, "projects", f), "utf8");

/** Deep compare with a numeric tolerance (serialisation rounds to 1e-6). */
function approxEqual(a: unknown, b: unknown, eps = 1e-5): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= eps;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => approxEqual(v, b[i], eps));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => approxEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], eps));
  }
  return a === b;
}

function pinScene(doc: Doc, page: Page, elId: string, pinId: string): Pt | null {
  const inst = page.elements.find((e) => e.id === elId);
  const def = inst && doc.defs[inst.defId];
  const pin = def?.pins.find((p) => p.id === pinId);
  return inst && pin ? toScene(inst, pin) : null;
}
function endPoint(doc: Doc, page: Page, end: Wire["a"]): Pt | null {
  if (end.k === "pin") return pinScene(doc, page, end.el, end.pin);
  if (end.k === "junction") {
    const j = page.junctions.find((jj) => jj.id === end.j);
    return j ? { x: j.x, y: j.y } : null;
  }
  return null;
}
const near = (a: Pt, b: Pt, eps = 0.01) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

/* ================================================================== */
/* .elmt                                                               */
/* ================================================================== */

describe("parseElmt", () => {
  it.each(elmtFiles)("parses %s with a sane bounding box", (f) => {
    const def = parseElmt(readElmt(f), { id: `lib/${f}` });
    expect(def.width).toBeGreaterThan(0);
    expect(def.height).toBeGreaterThan(0);
    expect(Object.keys(def.names).length).toBeGreaterThan(0);
    expect(def.prims.length).toBeGreaterThan(0);
    const bb = primsBBox(def);
    expect(bb).not.toBeNull();
    for (const v of [bb!.x, bb!.y, bb!.w, bb!.h]) expect(Number.isFinite(v)).toBe(true);
    // drawing stays in the neighbourhood of the declared element box
    const slack = 200;
    expect(bb!.x).toBeGreaterThan(-def.hotspotX - slack);
    expect(bb!.y).toBeGreaterThan(-def.hotspotY - slack);
    expect(bb!.x + bb!.w).toBeLessThan(def.width - def.hotspotX + slack);
    expect(bb!.y + bb!.h).toBeLessThan(def.height - def.hotspotY + slack);
    for (const p of def.pins) {
      expect(["n", "e", "s", "w"]).toContain(p.orient);
      expect(p.id).toMatch(/^([0-9a-f-]{36}|t\d+)$/);
    }
  });

  it("reads attributes of every primitive kind", () => {
    const def = parseElmt(readElmt("bobine3.elmt"));
    expect(def.uuid).toBe("793302b1-e96a-f7f8-70bc-dec53eeaab5b");
    expect(def.linkType).toBe("master");
    expect(def.kind.type).toBe("coil");
    expect(def.names.fr).toBe("Bobine");
    expect(def.pins.map((p) => [p.name, p.x, p.y, p.orient])).toEqual([
      ["A1", 0, -20, "n"],
      ["A2", 0, 20, "s"],
    ]);
    expect(def.pins[0].id).toBe("8d0fa333-2d98-4a75-8a4e-21c81cce7ec3");
    const label = def.prims.find((p): p is Extract<Prim, { t: "dyntext" }> => p.t === "dyntext" && p.info === "label");
    expect(label).toMatchObject({ from: "ElementInfo", x: 25, y: -9.17, size: 9, halign: "left", valign: "top" });
    const arcs = parseElmt(readElmt("motor_choke_3p.elmt")).prims.filter((p) => p.t === "arc");
    expect(arcs.length).toBe(12);
    const poly = parseElmt(readElmt("diode.elmt")).prims.find((p) => p.t === "polygon");
    expect(poly && poly.t === "polygon" && poly.pts.length).toBeGreaterThanOrEqual(3);
  });

  it("converts legacy <circle> and <input>", () => {
    const xml = `<definition type="element" width="20" height="50" hotspot_x="11" hotspot_y="25" link_type="simple" version="0.4">
      <names><name lang="en">Legacy</name></names>
      <description>
        <circle diameter="4" x="-2" y="-12" style="line-style:dashed;line-weight:thin;filling:black;color:red"/>
        <input size="9" x="3.75" y="3" text="_"/>
        <input size="9" x="3.75" y="13" text="x" tagg="comment" rotation="90"/>
        <terminal orientation="n" x="0" y="-21"/>
        <terminal orientation="s" x="0" y="21" name="2"/>
      </description>
    </definition>`;
    const def = parseElmt(xml, { id: "embed://import/legacy.elmt" });
    expect(def.prims[0]).toEqual({
      t: "ellipse",
      x: -2,
      y: -12,
      w: 4,
      h: 4,
      style: { lineStyle: "dashed", lineWeight: "thin", filling: "black", color: "red" },
    });
    const t0 = def.prims[1];
    // first input becomes the label (Element::buildFromXml workaround); middle-left -> top-left
    expect(t0).toMatchObject({ t: "dyntext", from: "ElementInfo", info: "label", text: "_", size: 9 });
    if (t0.t !== "dyntext") throw new Error();
    expect(t0.x).toBeCloseTo(3.75);
    expect(t0.y).toBeCloseTo(3 - 11.5);
    const t1 = def.prims[2];
    if (t1.t !== "dyntext") throw new Error();
    expect(t1.info).toBe("comment");
    expect(t1.x).toBeCloseTo(3.75 + 11.5); // rotated 90°: offset (0,-h/2) -> (+h/2, 0)
    expect(t1.y).toBeCloseTo(13);
    expect(def.pins.map((p) => p.id)).toEqual(["t0", "t1"]);
    expect(def.pins[1]).toMatchObject({ name: "2", number: "2" });
  });
});

describe("serializeElmt", () => {
  it.each(elmtFiles)("round-trips %s", (f) => {
    const src = readElmt(f);
    const def = parseElmt(src, { id: f });
    // unchanged definition: original text is kept byte-identical
    expect(serializeElmt(def)).toBe(src);
    // from scratch
    const fresh = serializeElmt({ ...def, xml: undefined });
    const again = parseElmt(fresh, { id: f });
    expect(approxEqual(again.prims, def.prims)).toBe(true);
    expect(approxEqual(again.pins, def.pins)).toBe(true);
    expect(again.names).toEqual(def.names);
    expect(again.kind).toEqual(def.kind);
    expect(again.linkType).toBe(def.linkType);
    expect(again.uuid).toBe(def.uuid);
  });

  it("patches a modified definition and keeps unknown nodes/attributes", () => {
    const src = readElmt("bobine3.elmt").replace("<description>", `<description foo="1"><foo_unknown bar="1"><x/></foo_unknown>`).replace('<definition ', '<definition custom_attr="keep" ');
    const def = parseElmt(src, { id: "coil" });
    def.pins[0] = { ...def.pins[0], x: 10, name: "X1" };
    def.prims.push({ t: "line", x1: 0, y1: 0, x2: 5, y2: 5, end1: "triangle", end2: "none", len1: 2, len2: 1.5, style: def.prims[0].t === "rect" ? def.prims[0].style : (undefined as never) });
    const out = serializeElmt(def);
    expect(out).toContain("<foo_unknown bar=\"1\">");
    expect(out).toContain('custom_attr="keep"');
    const again = parseElmt(out, { id: "coil" });
    expect(approxEqual(again.prims, def.prims)).toBe(true);
    expect(again.pins[0]).toMatchObject({ x: 10, name: "X1", id: def.pins[0].id });
    // untouched primitive nodes keep their extra attributes (z, keep_visual_rotation, ...)
    expect(out).toMatch(/<dynamic_text[^>]*keep_visual_rotation="false"/);
  });
});

/* ================================================================== */
/* title blocks                                                        */
/* ================================================================== */

describe("title block templates", () => {
  it("parses grid syntax", () => {
    expect(parseRows("25;25;")).toEqual([25, 25]);
    expect(parseRows("10px;x;12")).toEqual([10, 12]);
    expect(parseCols("t22%;r100%;25;")).toEqual([
      { kind: "t", v: 22 },
      { kind: "r", v: 100 },
      { kind: "abs", v: 25 },
    ]);
  });

  it("parses and re-serialises an embedded template", () => {
    const x = parseXml(readQet("2612_ats_singlephase.qet"));
    const node = subChildren(x.documentElement, "titleblocktemplates", "titleblocktemplate")[0];
    const xml = serializeXml(node);
    const t = parseTitleBlockTemplate(xml);
    expect(t.name).toBe("shelly_title_block");
    expect(t.rows).toEqual([10, 10, 10, 10, 10, 10]);
    expect(t.cols.length).toBe(14);
    expect(t.cells.find((c) => c.type === "logo")).toMatchObject({ row: 0, col: 9, rowspan: 2, value: "shelly_svg_logo.svg" });
    expect(t.cells.find((c) => c.name === "date")).toMatchObject({ value: "%date", label: "Date", showLabel: false, size: 9 });
    expect(serializeTitleBlockTemplate(t)).toBe(xml);
    // the template's t-columns add up to 98 %: QET does not stretch them (TitleBlockTemplate::columnsWidth)
    const widths = titleBlockColumnWidths(t, 1000);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(980);
    expect(titleBlockColumnWidths({ ...t, cols: parseCols("t22%;r100%;25;") }, 400)).toEqual([88, 287, 25]);

    t.cells[0] = { ...t.cells[0], value: "%author", size: 7 };
    const out = serializeTitleBlockTemplate(t);
    expect(out).toContain("<logos>"); // kept
    const again = parseTitleBlockTemplate(out);
    expect(again.cells[0]).toMatchObject({ value: "%author", size: 7 });
    expect(again.cells.length).toBe(t.cells.length);
  });
});

/* ================================================================== */
/* project import                                                      */
/* ================================================================== */

describe("importQet", () => {
  it.each(qetFiles)("imports %s", (f) => {
    const xml = readQet(f);
    const { doc, report } = importQet(xml, f);
    const x = parseXml(xml);
    const diagrams = Array.from({ length: x.getElementsByTagName("diagram").length }, (_, i) => x.getElementsByTagName("diagram").item(i)!);
    expect(doc.pages.length).toBe(diagrams.length);
    expect(report.pageCount).toBe(diagrams.length);
    expect(doc.qet?.source).toBe(xml);
    expect(report.items.filter((i) => i.level === "unsupported")).toEqual([]);

    diagrams.forEach((d, i) => {
      const page = doc.pages[i];
      expect(page.title).toBe(attr(d, "title"));
      const nEl = subChildren(d, "elements", "element").length;
      const kept = (page.meta["qet:keepElements"] ?? "").split(",").filter(Boolean).length;
      expect(page.elements.length + page.junctions.length + kept).toBe(nEl);
      const nCond = subChildren(d, "conductors", "conductor").length;
      const keptC = (page.meta["qet:keepConductors"] ?? "").split(",").filter(Boolean).length;
      expect(page.wires.length + keptC).toBe(nCond);
      if (keptC) expect(report.items.some((it) => it.level === "degraded" && it.area === "conductors")).toBe(true);
      expect(page.texts.length).toBe(subChildren(d, "inputs", "input").length);

      for (const w of page.wires) {
        for (const end of [w.a, w.b]) {
          expect(end.k).not.toBe("free");
          if (end.k === "pin") {
            const inst = page.elements.find((e) => e.id === end.el);
            expect(inst, `element ${end.el}`).toBeDefined();
            expect(doc.defs[inst!.defId]?.pins.some((p) => p.id === end.pin)).toBe(true);
          }
        }
        // the stored path starts at terminal1's dock point and ends (within QET's 1 unit tolerance) at terminal2
        const a = endPoint(doc, page, w.a)!;
        const b = endPoint(doc, page, w.b)!;
        expect(near(w.pts[0], a)).toBe(true);
        expect(Math.hypot(w.pts[w.pts.length - 1].x - b.x, w.pts[w.pts.length - 1].y - b.y)).toBeLessThanOrEqual(1.0001);
      }
    });
    // no path was inconsistent with its terminals -> dock points / rotations / origin agree with QET
    expect(report.items.find((i) => i.message.includes("inconsistent"))).toBeUndefined();
  });

  it("reads page, title block and element data", () => {
    const { doc } = importQet(readQet("2612_ats_singlephase.qet"), "2612_ats_singlephase.qet");
    const p = doc.pages[0];
    expect(p.border).toMatchObject({ cols: 34, rows: 16, colW: 60, rowH: 80, headerW: 20, headerH: 20 });
    expect(p.titleBlock.template).toBe("shelly_title_block");
    expect(p.titleBlock.fields.author).toBe("Orlin Dimitrov");
    expect(p.titleBlock.fields.version).toBe("0.90");
    expect(doc.titleBlocks.shelly_title_block.rows.length).toBe(6);
    const withLabel = p.elements.find((e) => e.info.label);
    expect(withLabel).toBeDefined();
    const labelText = withLabel!.texts.find((t) => t.info === "label");
    if (labelText) expect(labelText.role).toBe("componentRef");
    expect(Object.keys(doc.defs).every((k) => k.startsWith("embed://import/"))).toBe(true);
  });

  it("offsets QET scene coordinates by the diagram margin", () => {
    const { doc } = importQet(readQet("schema_unifilaire_voltaique2.qet"), "x.qet");
    const first = doc.pages[0].elements[0];
    // <element x="600" y="610"> in the file
    expect(first.x).toBe(600 - QET_MARGIN);
    expect(first.y).toBe(610 - QET_MARGIN);
    expect(first.qet?.terminalIds).toEqual({ t0: "0", t1: "1" });
  });

  it("builds placeholders for missing definitions and resolves their terminals", () => {
    let xml = readQet("741.qet");
    const x = parseXml(xml);
    const coll = child(x.documentElement, "collection")!;
    const firstDiagram = x.getElementsByTagName("diagram").item(0)!;
    // pick the type of an element that has conductors
    const used = subChildren(firstDiagram, "elements", "element").find((e) => subChildren(e, "terminals", "terminal").length >= 2)!;
    const type = attr(used, "type");
    const file = type.split("/").pop()!;
    const all = coll.getElementsByTagName("element");
    for (let i = 0; i < all.length; i++) {
      const e = all.item(i)!;
      if (attr(e, "name") === file) {
        e.parentNode!.removeChild(e);
        break;
      }
    }
    xml = serializeXml(x);
    const { doc, report } = importQet(xml, "741.qet");
    expect(doc.defs[type].placeholder).toBe(true);
    expect(doc.defs[type].pins.length).toBeGreaterThan(0);
    expect(report.items.some((i) => i.level === "degraded" && i.message.includes("placeholder"))).toBe(true);
    const n = subChildren(firstDiagram, "conductors", "conductor").length;
    expect(doc.pages[0].wires.length).toBe(n);
    // re-export keeps the external reference and its terminal list
    const out = exportQet(doc).xml;
    expect(out).toBe(xml);
  });
});

/* ================================================================== */
/* export                                                              */
/* ================================================================== */

function compareDocs(a: Doc, b: Doc) {
  expect(b.pages.length).toBe(a.pages.length);
  a.pages.forEach((pa, i) => {
    const pb = b.pages[i];
    expect(pb.title).toBe(pa.title);
    expect(pb.elements.length).toBe(pa.elements.length);
    expect(pb.wires.length).toBe(pa.wires.length);
    expect(pb.junctions.length).toBe(pa.junctions.length);
    const posA = pa.elements.map((e) => `${e.defId}@${e.x.toFixed(2)},${e.y.toFixed(2)}r${e.rot}`).sort();
    const posB = pb.elements.map((e) => `${e.defId}@${e.x.toFixed(2)},${e.y.toFixed(2)}r${e.rot}`).sort();
    expect(posB).toEqual(posA);
    const wireKey = (d: Doc, p: Page, w: Wire) => {
      const ea = endPoint(d, p, w.a)!;
      const eb = endPoint(d, p, w.b)!;
      return `${w.label ?? ""}|${ea.x.toFixed(2)},${ea.y.toFixed(2)}|${eb.x.toFixed(2)},${eb.y.toFixed(2)}|${w.pts.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(";")}`;
    };
    expect(pb.wires.map((w) => wireKey(b, pb, w)).sort()).toEqual(pa.wires.map((w) => wireKey(a, pa, w)).sort());
    expect(pb.texts.map((t) => `${t.text}@${t.x.toFixed(2)},${t.y.toFixed(2)}`).sort()).toEqual(pa.texts.map((t) => `${t.text}@${t.x.toFixed(2)},${t.y.toFixed(2)}`).sort());
  });
}

describe("exportQet", () => {
  it.each(qetFiles)("unchanged %s is written back byte-identical and valid", (f) => {
    const xml = readQet(f);
    const { doc } = importQet(xml, f);
    const { xml: out, report } = exportQet(doc);
    expect(out).toBe(xml);
    expect(validateQet(out)).toEqual([]);
    expect(report.items.filter((i) => i.level === "unsupported")).toEqual([]);
  });

  it.each(qetFiles)("round-trips an edited %s", (f) => {
    const { doc } = importQet(readQet(f), f);
    const page = doc.pages[0];
    // move an element and re-route its wires orthogonally
    const el = page.elements.find((e) => page.wires.some((w) => (w.a.k === "pin" && w.a.el === e.id) || (w.b.k === "pin" && w.b.el === e.id)));
    if (el) {
      el.x += 20;
      el.y += 10;
      for (const w of page.wires) {
        const a = endPoint(doc, page, w.a)!;
        const b = endPoint(doc, page, w.b)!;
        if ((w.a.k === "pin" && w.a.el === el.id) || (w.b.k === "pin" && w.b.el === el.id)) w.pts = a.x === b.x || a.y === b.y ? [a, b] : [a, { x: a.x, y: b.y }, b];
      }
    }
    // relabel a wire, edit / add texts, delete an element with its wires
    if (page.wires[0]) page.wires[0].label = "W-42";
    page.texts.push({ id: "t-new", x: 100, y: 100, text: "Added\nby Volt", role: "annotation" });
    const victim = page.elements.find((e) => e !== el);
    if (victim) {
      page.elements = page.elements.filter((e) => e !== victim);
      page.wires = page.wires.filter((w) => !((w.a.k === "pin" && w.a.el === victim.id) || (w.b.k === "pin" && w.b.el === victim.id)));
    }
    page.title = "Edited folio";
    const { xml: out } = exportQet(doc);
    expect(validateQet(out)).toEqual([]);
    const { doc: again } = importQet(out, f);
    compareDocs(doc, again);
    expect(again.pages[0].wires.some((w) => w.label === "W-42") || !doc.pages[0].wires.length).toBe(true);
  });

  it("adds new elements, wires and pages to an existing project", () => {
    const { doc } = importQet(readQet("schema_unifilaire_voltaique2.qet"), "v.qet");
    const page = doc.pages[0];
    const defId = Object.keys(doc.defs).find((k) => doc.defs[k].pins.length >= 2)!;
    const def = doc.defs[defId];
    const mk = (id: string, x: number): ElemInst => ({ id, defId, x, y: 700, rot: 1, mirror: false, info: { label: `N${x}` }, texts: [] });
    const e1 = mk("0b7a3b8e-2f0c-4d8e-9a55-0000000000a1", 100);
    const e2 = mk("0b7a3b8e-2f0c-4d8e-9a55-0000000000a2", 300);
    page.elements.push(e1, e2);
    const a = toScene(e1, def.pins[0]);
    const b = toScene(e2, def.pins[1]);
    page.wires.push({ id: "0b7a3b8e-2f0c-4d8e-9a55-0000000000b1", a: { k: "pin", el: e1.id, pin: def.pins[0].id }, b: { k: "pin", el: e2.id, pin: def.pins[1].id }, pts: [a, { x: a.x, y: 760 }, { x: b.x, y: 760 }, b], label: "NEW" });
    const p2 = { ...page, id: "0b7a3b8e-2f0c-4d8e-9a55-0000000000c1", title: "Second", order: 1, qet: undefined, elements: [], wires: [], junctions: [], texts: [], shapes: [], meta: {} };
    doc.pages.push(p2);
    const { xml } = exportQet(doc);
    expect(validateQet(xml)).toEqual([]);
    const { doc: again } = importQet(xml, "v.qet");
    compareDocs(doc, again);
    const w = again.pages[0].wires.find((ww) => ww.label === "NEW")!;
    expect(w.pts.length).toBe(4);
    const ne = again.pages[0].elements.find((e) => e.id === e1.id)!;
    expect(ne.info.label).toBe("N100");
    // new instance carries the definition's texts explicitly (QET drops definition texts on load)
    expect(ne.texts.length).toBe(def.prims.filter((p) => p.t === "dyntext").length);
    // numeric terminal ids stay unique per diagram
    const x = parseXml(xml);
    const ids = subChildren(x.getElementsByTagName("diagram").item(0)!, "elements", "element").flatMap((e) => subChildren(e, "terminals", "terminal").map((t) => attr(t, "id")));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps unknown nodes at project, diagram and element level", () => {
    const inject = `<foo_unknown bar="1"><x/></foo_unknown>`;
    let xml = readQet("741.qet");
    xml = xml.replace(/(<project[^>]*>)/, `$1${inject}`);
    xml = xml.replace(/(<diagram [^>]*>)/, `$1${inject}`);
    xml = xml.replace(/(<element [^>]*type="embed[^>]*>)/, `$1${inject}`);
    const { doc, report } = importQet(xml, "741.qet");
    expect(report.items.filter((i) => i.level === "preserved" && i.message.includes("foo_unknown")).reduce((n, i) => n + (i.count ?? 0), 0)).toBe(3);
    // edit things around them
    const p = doc.pages[0];
    p.elements[0].x += 10;
    p.elements.reverse();
    p.title = "changed";
    const { xml: out } = exportQet(doc);
    const x = parseXml(out);
    const found = x.getElementsByTagName("foo_unknown");
    expect(found.length).toBe(3);
    const parents = Array.from({ length: found.length }, (_, i) => (found.item(i)!.parentNode as unknown as { tagName: string }).tagName).sort();
    expect(parents).toEqual(["diagram", "element", "project"]);
    for (let i = 0; i < found.length; i++) {
      expect(attr(found.item(i)!, "bar")).toBe("1");
      expect(children(found.item(i)!, "x").length).toBe(1);
    }
    expect(validateQet(out)).toEqual([]);
  });

  it("round-trips junctions through an embedded junction element", () => {
    const doc = newDoc("Junction test");
    const coil = parseElmt(readElmt("bobine3.elmt"), { id: "lib:coil" });
    doc.defs[coil.id] = coil;
    const page = doc.pages[0];
    const els: ElemInst[] = [0, 1, 2].map((i) => ({ id: `1c0a6c3e-0000-4000-8000-00000000000${i}`, defId: coil.id, x: 200 + i * 100, y: 300, rot: 0, mirror: false, info: { label: `K${i + 1}` }, texts: [] }));
    page.elements.push(...els);
    page.junctions.push({ id: "1c0a6c3e-0000-4000-8000-0000000000f0", x: 300, y: 200 });
    for (const [i, e] of els.entries()) {
      const pin = toScene(e, coil.pins[0]); // A1, top
      page.wires.push({
        id: `1c0a6c3e-0000-4000-8000-0000000000e${i}`,
        a: { k: "junction", j: page.junctions[0].id },
        b: { k: "pin", el: e.id, pin: coil.pins[0].id },
        pts: pin.x === 300 ? [{ x: 300, y: 200 }, pin] : [{ x: 300, y: 200 }, { x: pin.x, y: 200 }, pin],
        label: `L${i}`,
      });
    }
    // one free-ended wire
    const k3 = toScene(els[2], coil.pins[1]);
    page.wires.push({ id: "1c0a6c3e-0000-4000-8000-0000000000d0", a: { k: "pin", el: els[2].id, pin: coil.pins[1].id }, b: { k: "free" }, pts: [k3, { x: k3.x, y: k3.y + 40 }] });

    const { xml, report } = exportQet(doc);
    expect(validateQet(xml)).toEqual([]);
    expect(report.items.some((i) => i.level === "degraded" && i.message.includes("free wire ends"))).toBe(true);
    const x = parseXml(xml);
    const root = x.documentElement!;
    expect(attr(root, "version")).toMatch(/^0\.\d+/);
    expect(child(root, "newdiagrams")).not.toBeNull();
    const importCat = children(child(root, "collection"), "category").find((c) => attr(c, "name") === "import");
    expect(importCat && child(importCat, "names")).toBeTruthy();
    expect(xml).toContain(JUNCTION_DEF_PATH);
    // uuid terminal references (definition terminals have uuids)
    const conds = subChildren(x.getElementsByTagName("diagram").item(0)!, "conductors", "conductor");
    expect(conds.length).toBe(4);
    expect(conds.every((c) => attr(c, "element1").startsWith("{") && attr(c, "terminal2").startsWith("{"))).toBe(true);

    const { doc: again, report: r2 } = importQet(xml, "junction.qet");
    const p = again.pages[0];
    expect(p.junctions.length).toBe(2); // restored + the one generated for the free end
    const j = p.junctions.find((jj) => jj.x === 300 && jj.y === 200)!;
    expect(j).toBeDefined();
    const toJ = p.wires.filter((w) => (w.a.k === "junction" && w.a.j === j.id) || (w.b.k === "junction" && w.b.j === j.id));
    expect(toJ.length).toBe(3);
    expect(p.elements.length).toBe(3);
    expect(Object.keys(again.defs)).not.toContain(JUNCTION_DEF_PATH);
    expect(r2.items.some((i) => i.message.includes("junction"))).toBe(true);
    for (const w of toJ) {
      const orig = page.wires.find((ow) => ow.label === w.label)!;
      expect(w.pts.map((q) => [q.x, q.y])).toEqual(orig.pts.map((q) => [q.x, q.y]));
    }
    // and a second round trip is stable
    const { xml: xml2 } = exportQet(again);
    expect(xml2).toBe(xml);
  });

  it("generates a complete project from scratch", () => {
    const doc = newDoc("Scratch");
    const def: ElementDef = parseElmt(readElmt("disjonct-m_4fn.elmt"), { id: "lib:breaker" });
    doc.defs[def.id] = def;
    doc.pages[0].elements.push({ id: "2d0a6c3e-0000-4000-8000-000000000001", defId: def.id, x: 400, y: 300, rot: 2, mirror: false, info: { label: "Q1" }, texts: [] });
    doc.pages[0].texts.push({ id: "x", x: 50, y: 50, text: "Hello & <world>", role: "annotation" });
    doc.pages[0].titleBlock.fields.author = "Volt";
    doc.pages[0].titleBlock.fields.customer = "ACME";
    doc.meta.props.site = "Plant 1";
    const { xml } = exportQet(doc);
    expect(validateQet(xml)).toEqual([]);
    const { doc: again } = importQet(xml, "scratch.qet");
    expect(again.meta.title).toBe("Scratch");
    expect(again.meta.props.site).toBe("Plant 1");
    const p = again.pages[0];
    expect(p.titleBlock.fields.author).toBe("Volt");
    expect(p.titleBlock.fields.customer).toBe("ACME");
    expect(p.elements[0]).toMatchObject({ x: 400, y: 300, rot: 2, info: { label: "Q1" } });
    expect(p.texts[0].text).toBe("Hello & <world>");
    const d = again.defs[p.elements[0].defId];
    expect(approxEqual(d.pins, def.pins)).toBe(true);
    expect(approxEqual(d.prims, def.prims)).toBe(true);
  });
});

describe("qetAutoPath", () => {
  it("routes like Conductor::generateConductorPath", () => {
    // south terminal to north terminal further right/below: cas "4" horizontal bridge on grid
    expect(qetAutoPath({ x: 100, y: 100 }, "s", { x: 200, y: 200 }, "n")).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 110 },
      { x: 100, y: 150 },
      { x: 200, y: 150 },
      { x: 200, y: 190 },
      { x: 200, y: 200 },
    ]);
    // reversed order is expressed from terminal 1 to terminal 2
    const r = qetAutoPath({ x: 200, y: 200 }, "n", { x: 100, y: 100 }, "s");
    expect(r[0]).toEqual({ x: 200, y: 200 });
    expect(r[r.length - 1]).toEqual({ x: 100, y: 100 });
  });
});
