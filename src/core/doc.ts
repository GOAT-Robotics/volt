import type { Doc, ElemInst, ElementDef, Page, Styles, TitleBlockTemplate } from "./model";
import { defaultStyles } from "./styles";
import { uid } from "./ids";

export const DEFAULT_TB = "default";

/** Built-in title block (approximates QElectroTech "default" template). */
export function defaultTitleBlock(): TitleBlockTemplate {
  const f = (row: number, col: number, name: string, label: string, value: string, extra: Partial<TitleBlockTemplate["cells"][number]> = {}) => ({
    row, col, rowspan: 0, colspan: 0, type: "field" as const, name, label, showLabel: true, value, align: "left" as const, size: 8, ...extra,
  });
  return {
    name: DEFAULT_TB,
    rows: [25, 25],
    cols: [{ kind: "t", v: 22 }, { kind: "r", v: 100 }, { kind: "t", v: 22 }, { kind: "abs", v: 90 }],
    cells: [
      f(0, 0, "author", "Author", "%author"),
      f(1, 0, "date", "Date", "%date"),
      f(0, 1, "title", "Title", "%title", { rowspan: 1, showLabel: false, align: "center", size: 11 }),
      f(0, 2, "filename", "File", "%filename"),
      f(1, 2, "folio", "Folio", "%folio"),
      f(0, 3, "version", "Version", "%version"),
      f(1, 3, "indexrev", "Rev", "%indexrev"),
    ],
  };
}

export function newPage(order: number, title = `Page ${order + 1}`): Page {
  return {
    id: uid(),
    title,
    order,
    border: { show: true, cols: 17, rows: 8, colW: 60, rowH: 80, headerW: 20, headerH: 20, showCols: true, showRows: true },
    titleBlock: { show: true, template: DEFAULT_TB, fields: { author: "", date: "", title, filename: "", indexrev: "", version: "" } },
    elements: [],
    wires: [],
    junctions: [],
    texts: [],
    shapes: [],
    meta: {},
  };
}

export function newDoc(title: string, base?: Styles): Doc {
  return {
    schema: 1,
    meta: { title, props: {} },
    baseStyles: base ?? defaultStyles(),
    styles: {},
    numbering: {
      autoOnPlace: true,
      rules: [{ id: uid(), match: "*", prefix: "", scope: "project", format: "{prefix}{n}", start: 1 }],
    },
    pages: [newPage(0)],
    defs: {},
    titleBlocks: { [DEFAULT_TB]: defaultTitleBlock() },
    grid: { size: 10, show: true },
  };
}

/** Page drawing area (border rectangle incl. headers, excl. title block). */
export function pageFrame(p: Page) {
  const b = p.border;
  const w = b.headerW + b.cols * b.colW;
  const h = b.headerH + b.rows * b.rowH;
  const tbH = p.titleBlock.show ? 50 : 0;
  return { x: 0, y: 0, w, h, tbH, total: { x: 0, y: 0, w, h: h + tbH } };
}

export function elementLabel(e: ElemInst): string {
  return e.info.label ?? e.info.formula ?? "";
}

export function defDisplayName(d: ElementDef, lang = "en"): string {
  return d.names[lang] ?? d.names.en ?? Object.values(d.names)[0] ?? d.name;
}

export function allPages(doc: Doc): Page[] {
  return [...doc.pages].sort((a, b) => a.order - b.order);
}
