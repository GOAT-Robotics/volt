import { describe, expect, it } from "vitest";
import { addWire, newElement } from "../ops";
import { toScene } from "../geometry";
import { builtinTerminalDef, collectStrips } from "../terminals";
import { replaceSymbol } from "../replace";
import { mkDef, mkDoc, twoPin } from "./helpers";

describe("replace symbol", () => {
  it("turns a one-pin end terminal into a feed-through, wires split top / bottom", () => {
    const { doc, page } = mkDoc();
    const end = mkDef("end", [{ id: "1", x: 0, y: -10, orient: "n" }], { linkType: "terminal", name: "terminal", prefix: "X" });
    const q = newElement(doc, page, twoPin("q"), { x: 200, y: 100 });
    q.info.label = "Q1";
    const k = newElement(doc, page, twoPin("k"), { x: 200, y: 500 });
    k.info.label = "K1";
    const x = newElement(doc, page, end, { x: 200, y: 300 });
    x.info.label = "X1:1";
    const xp = toScene(x, end.pins[0]);
    const qp = toScene(q, doc.defs[q.defId].pins[1]), kp = toScene(k, doc.defs[k.defId].pins[0]);
    addWire(page, { k: "pin", el: q.id, pin: doc.defs[q.defId].pins[1].id, p: qp }, { k: "pin", el: x.id, pin: "1", p: xp }, [qp, { x: xp.x, y: qp.y }, xp]);
    addWire(page, { k: "pin", el: x.id, pin: "1", p: xp }, { k: "pin", el: k.id, pin: doc.defs[k.defId].pins[0].id, p: kp }, [xp, { x: xp.x, y: kp.y }, kp]);
    const r = replaceSymbol(doc, page, x, builtinTerminalDef());
    expect(r).toEqual({ moved: 2, loose: 0 });
    expect(x.info.label).toBe("X1:1");
    const ends = page.wires.flatMap((w) => [w.a, w.b]).filter((e) => e.k === "pin" && e.el === x.id).map((e) => (e as { pin: string }).pin).sort();
    expect(ends).toEqual(["1", "2"]);
    const row = collectStrips(doc).find((v) => v.tag === "X1")!.rows[0];
    expect(row.conn1[0].to).toEqual(["Q1:2"]);
    expect(row.conn2[0].to).toEqual(["K1:1"]);
  });
});
