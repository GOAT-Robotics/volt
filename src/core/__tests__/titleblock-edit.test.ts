import { describe, expect, it } from "vitest";
import type { TitleBlockTemplate } from "../model";
import { deleteCol, deleteRow, fits, insertCol, insertRow, mergeCells, moveCell, occupancy, parseColSpec, resizeCol, spanCell, templateVariables } from "../titleblock-edit";
import { titleBlockColumnWidths } from "../qet/titleblock";

const f = (row: number, col: number, name: string, extra: Partial<TitleBlockTemplate["cells"][number]> = {}) => ({ row, col, rowspan: 0, colspan: 0, type: "field" as const, name, value: `%${name}`, ...extra });
const base = (): TitleBlockTemplate => ({
  name: "t",
  rows: [25, 25],
  cols: [{ kind: "abs", v: 80 }, { kind: "r", v: 50 }, { kind: "r", v: 50 }],
  cells: [{ row: 0, col: 0, rowspan: 1, colspan: 0, type: "logo", value: "Logo.png" }, f(0, 1, "author"), f(1, 1, "date"), f(0, 2, "title", { rowspan: 1 })],
});

describe("title block editing", () => {
  it("knows which slots are taken", () => {
    const t = base();
    expect(occupancy(t).get("1:0")).toBe(0);
    expect(fits(t, 1, 1, 0, 0)).toBe(false);
    expect(fits(t, 1, 1, 0, 0, 2)).toBe(true);
    expect(fits(t, 1, 2, 1, 0)).toBe(false); // outside the grid
  });

  it("moves and swaps cells", () => {
    const t = base();
    const s = moveCell(t, 1, 1, 1)!; // author onto date: same size → swap
    expect(s.cells[1]).toMatchObject({ row: 1, col: 1 });
    expect(s.cells[2]).toMatchObject({ row: 0, col: 1 });
    expect(moveCell(t, 1, 0, 2)).toBeNull(); // onto the spanning title
    const freed = { ...t, cells: t.cells.filter((c) => c.name !== "date") };
    expect(moveCell(freed, 1, 1, 1)!.cells[1]).toMatchObject({ row: 1, col: 1 });
  });

  it("merges, spans and splits", () => {
    const t = base();
    expect(mergeCells(t, [1, 3])).toBeNull(); // date sits between? no — bounding box 0..1 × 1..2 holds date
    const m = mergeCells(t, [1, 2])!;
    expect(m.t.cells[m.index]).toMatchObject({ name: "author", row: 0, col: 1, rowspan: 1 });
    expect(m.t.cells.length).toBe(3);
    expect(spanCell(t, 1, 0, 1)).toBeNull();
  });

  it("inserts and deletes rows and columns, keeping spans", () => {
    const t = base();
    const r = insertRow(t, 1);
    expect(r.rows).toEqual([25, 25, 25]);
    expect(r.cells[0]).toMatchObject({ row: 0, rowspan: 2 }); // logo spans across the new row
    expect(r.cells[2]).toMatchObject({ row: 2 });
    const d = deleteRow(t, 1)!;
    expect(d.rows).toEqual([25]);
    expect(d.cells.map((c) => c.name ?? c.value)).toEqual(["Logo.png", "author", "title"]);
    expect(d.cells[0].rowspan).toBe(0);
    const c = insertCol(t, 1);
    expect(c.cells[1].col).toBe(2);
    expect(deleteCol(c, 1)!.cells[1].col).toBe(1);
  });

  it("resizes a column border without changing the total width", () => {
    const t = base();
    const w = titleBlockColumnWidths(t, 1000);
    const n = resizeCol(t, 1, 92, w, 1000);
    const w2 = titleBlockColumnWidths(n, 1000);
    expect(w2.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(w2[1]).toBeGreaterThan(w[1] + 80);
    expect(resizeCol(t, 0, 20, w, 1000).cols[0]).toEqual({ kind: "abs", v: 100 });
  });

  it("parses column specs and lists variables", () => {
    expect(parseColSpec("80px")).toEqual({ kind: "abs", v: 80 });
    expect(parseColSpec("t10%")).toEqual({ kind: "t", v: 10 });
    expect(parseColSpec("x")).toBeNull();
    expect([...templateVariables(base())].sort()).toEqual(["author", "date", "title"]);
  });
});

describe("resize keeps the frame width", () => {
  it("fixed column next to a relative one", () => {
    const t: TitleBlockTemplate = { name: "g", rows: [25], cols: [{ kind: "abs", v: 80 }, { kind: "r", v: 25 }, { kind: "r", v: 50 }, { kind: "r", v: 25 }, { kind: "abs", v: 80 }], cells: [] };
    const w = titleBlockColumnWidths(t, 1200);
    const n = resizeCol(t, 0, 54, w, 1200);
    const w2 = titleBlockColumnWidths(n, 1200);
    expect(w2.reduce((a, b) => a + b, 0)).toBe(1200);
    expect(w2[0]).toBe(134);
    expect(Math.abs(w2[1] - (w[1] - 54))).toBeLessThanOrEqual(12);
    expect(n.cols.filter((c) => c.kind === "r").reduce((a, c) => a + c.v, 0)).toBe(100);
  });
});
