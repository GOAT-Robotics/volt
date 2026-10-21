/**
 * "No connect" pins (KiCad's ✕ flag): a pin left open on purpose. It is drawn with an ✕, the checks
 * stop reporting it as unconnected — and report it if a wire lands on it after all.
 */
import type { Doc, ElemInst, Page } from "./model";
import { projectNets } from "./erc";

export const isNoConnect = (e: Pick<ElemInst, "noConnect">, pinId: string) => !!e.noConnect?.includes(pinId);

/** flag (or unflag) pins of a component */
export function setNoConnect(e: ElemInst, pinIds: string[], on: boolean) {
  const cur = new Set(e.noConnect ?? []);
  for (const id of pinIds) {
    if (on) cur.add(id);
    else cur.delete(id);
  }
  if (cur.size) e.noConnect = [...cur];
  else delete e.noConnect;
}

/** pins of a component with a wire on them on its sheet */
export function wiredPins(page: Page, elId: string): Set<string> {
  const out = new Set<string>();
  for (const w of page.wires) for (const end of [w.a, w.b]) if (end.k === "pin" && end.el === elId) out.add(end.pin);
  return out;
}

/** pins that connect to nothing at all (no wire, nor through a mated connector, an off-page arrow or a terminal) */
export function freePins(doc: Doc, e: ElemInst, nets = projectNets(doc).netOfPin): string[] {
  const def = doc.defs[e.defId];
  return (def?.pins ?? []).filter((p) => !nets.has(`${e.id}/${p.id}`)).map((p) => p.id);
}
