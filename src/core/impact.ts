/**
 * What deleting a selection affects — shown before deleting anything that is used elsewhere:
 * cross-references (coil ↔ contacts, folio report pairs, mated connectors), placed blocks, the
 * connections the deletion breaks, wire numbers that continue on other sheets, cable cores,
 * terminal strips and review comments. It also offers related items to delete together and, after
 * deleting, closing the gaps in reference designations (K1, K2, K4 → K1, K2, K3) and wire numbers.
 */
import type { Doc, ElemInst, Page, Wire } from "./model";
import type { Sel } from "./ops";
import { deleteSelection } from "./ops";
import { indexElements, isTerminal, projectNets } from "./erc";
import { ruleFor, type RefChange } from "./numbering";
import { circuitKey, wireNumberingOf } from "./wirenumber";

export type ImpactRef = { pageId: string; id: string; text: string; kind: "element" | "wire" | "comment" };
export type ImpactItem = {
  code: string;
  level: "warning" | "info";
  message: string;
  refs: ImpactRef[];
  /** items that the "delete related items too" option adds (ids by page) */
  related?: { pageId: string; elements?: string[]; wires?: string[]; junctions?: string[] }[];
};
export type DeleteImpact = {
  items: ImpactItem[];
  /** references of components that will no longer exist anywhere (gaps to close) */
  freedRefs: string[];
  /** counts of what is deleted */
  counts: { elements: number; wires: number; other: number };
};

const isReport = (lt?: string) => lt === "next_report" || lt === "previous_report";
const pageNo = (doc: Doc) => new Map([...doc.pages].sort((a, b) => a.order - b.order).map((p, i) => [p.id, i + 1]));

function elText(doc: Doc, e: ElemInst) {
  const d = doc.defs[e.defId];
  return e.info.label || d?.name || "component";
}

export function deleteImpact(doc: Doc, page: Page, sel: Sel, opts: { comments?: { id: string; anchor: { type: string; id?: string } | null; status: string; body: string; pageId: string | null }[] } = {}): DeleteImpact {
  const items: ImpactItem[] = [];
  const idx = indexElements(doc);
  const pn = pageNo(doc);
  const where = (pageId: string) => (pageId === page.id ? "this sheet" : `sheet ${pn.get(pageId) ?? "?"}`);
  const delEls = new Set(sel.elements);
  const delWires = new Set(sel.wires);
  const els = page.elements.filter((e) => delEls.has(e.id));
  const wires = page.wires.filter((w) => delWires.has(w.id));

  /* ---------- components ---------- */
  const attached: Wire[] = [];
  for (const w of page.wires) {
    if (delWires.has(w.id)) continue;
    if ((w.a.k === "pin" && delEls.has(w.a.el)) || (w.b.k === "pin" && delEls.has(w.b.el))) attached.push(w);
  }
  if (attached.length) {
    // wires that would be left with both ends free (or one end free and nothing else) can go too
    items.push({
      code: "wires.dangling",
      level: "info",
      message: `${attached.length} wire${attached.length === 1 ? " stays" : "s stay"} on the sheet with a loose end (they reconnect when a component is dropped on them)`,
      refs: attached.slice(0, 12).map((w) => ({ pageId: page.id, id: w.id, text: w.label || "wire", kind: "wire" })),
      related: [{ pageId: page.id, wires: attached.map((w) => w.id) }],
    });
  }
  for (const e of els) {
    const def = doc.defs[e.defId];
    const name = elText(doc, e);
    // master (coil, switch body) ↔ its contacts
    if (def?.linkType === "master" || def?.linkType === "slave") {
      const linked = (e.links ?? []).map((l) => idx.get(l)).filter((x): x is NonNullable<typeof x> => !!x && !delEls.has(x.e.id));
      if (linked.length)
        items.push({
          code: def.linkType === "master" ? "xref.slaves" : "xref.master",
          level: def.linkType === "master" ? "warning" : "info",
          message:
            def.linkType === "master"
              ? `${name} operates ${linked.length} contact${linked.length === 1 ? "" : "s"} elsewhere (${[...new Set(linked.map((x) => where(x.page.id)))].join(", ")}) — they would refer to a component that no longer exists`
              : `This is a contact of ${linked.map((x) => elText(doc, x.e)).join(", ")} (${[...new Set(linked.map((x) => where(x.page.id)))].join(", ")}); its cross-reference is updated`,
          refs: linked.map((x) => ({ pageId: x.page.id, id: x.e.id, text: `${elText(doc, x.e)} · ${where(x.page.id)}`, kind: "element" })),
          related: def.linkType === "master" ? groupByPage(linked.map((x) => ({ pageId: x.page.id, id: x.e.id }))) : undefined,
        });
    }
    // folio report pair
    if (isReport(def?.linkType)) {
      const other = (e.links ?? []).map((l) => idx.get(l)).filter((x): x is NonNullable<typeof x> => !!x && !delEls.has(x.e.id));
      if (other.length)
        items.push({
          code: "xref.report",
          level: "warning",
          message: `This folio report continues on ${other.map((x) => where(x.page.id)).join(", ")} — the conductor will end there`,
          refs: other.map((x) => ({ pageId: x.page.id, id: x.e.id, text: `report arrow · ${where(x.page.id)}`, kind: "element" })),
          related: groupByPage(other.map((x) => ({ pageId: x.page.id, id: x.e.id }))),
        });
    }
    // mated connector
    if (e.mate) {
      const o = idx.get(e.mate.id);
      if (o && !delEls.has(o.e.id))
        items.push({
          code: "xref.mate",
          level: "info",
          message: `${name} is mated with ${elText(doc, o.e)} (${where(o.page.id)}); that side becomes an unmated connector`,
          refs: [{ pageId: o.page.id, id: o.e.id, text: `${elText(doc, o.e)} · ${where(o.page.id)}`, kind: "element" }],
          related: [{ pageId: o.page.id, elements: [o.e.id] }],
        });
    }
    // other representations of the same device (same reference, e.g. coil drawn twice, multi-sheet device)
    const label = e.info.label?.trim();
    if (label && !isReport(def?.linkType)) {
      const same = [...idx.values()].filter((x) => x.e.id !== e.id && !delEls.has(x.e.id) && x.e.info.label?.trim() === label && x.def?.linkType !== "slave");
      if (same.length)
        items.push({
          code: "ref.shared",
          level: "info",
          message: `${label} also appears on ${[...new Set(same.map((x) => where(x.page.id)))].join(", ")} — the device stays in the project`,
          refs: same.map((x) => ({ pageId: x.page.id, id: x.e.id, text: `${label} · ${where(x.page.id)}`, kind: "element" })),
        });
    }
    // terminal strip row
    if (isTerminal(def) && label) {
      const strip = (doc.terminalStrips ?? []).find((s) => label.startsWith(s.tag + s.sep));
      if (strip) {
        const num = label.slice(strip.tag.length + strip.sep.length);
        if (strip.rows.some((r) => r.num === num && !r.spare))
          items.push({ code: "strip.row", level: "info", message: `Terminal ${label} stays in strip ${strip.tag} as a row without a drawing — mark it spare or remove it in Terminal strips`, refs: [] });
      }
    }
    // placed block
    if (e.group) {
      const g = e.group;
      const rest = doc.pages.flatMap((p) => [
        ...p.elements.filter((x) => x.group?.id === g.id && !delEls.has(x.id)).map((x) => ({ pageId: p.id, id: x.id, k: "e" as const })),
        ...p.wires.filter((x) => x.group?.id === g.id && !delWires.has(x.id)).map((x) => ({ pageId: p.id, id: x.id, k: "w" as const })),
      ]);
      if (rest.length && !items.some((i) => i.code === "block.partial" && i.message.includes(g.name)))
        items.push({
          code: "block.partial",
          level: "warning",
          message: `${name} is part of the placed block “${g.name}” (${g.mode}); ${rest.length} other item${rest.length === 1 ? "" : "s"} of that block stay and ${g.mode === "linked" ? "lose the link to the block (they will not update any more)" : "remain as loose items"}`,
          refs: rest.filter((r) => r.k === "e").slice(0, 12).map((r) => ({ pageId: r.pageId, id: r.id, text: elText(doc, idx.get(r.id)!.e), kind: "element" })),
          related: groupByPage(rest.filter((r) => r.k === "e").map((r) => ({ pageId: r.pageId, id: r.id })), rest.filter((r) => r.k === "w").map((r) => ({ pageId: r.pageId, id: r.id }))),
        });
    }
  }

  /* ---------- wires ---------- */
  const cfg = wireNumberingOf(doc);
  for (const w of wires) {
    if (!w.label) continue;
    const key = doc.wireNumbering ? circuitKey(w.label, cfg) ?? w.label : w.label;
    const others = doc.pages.flatMap((p) => p.wires.filter((x) => x.id !== w.id && !delWires.has(x.id) && x.label && (doc.wireNumbering ? circuitKey(x.label, cfg) ?? x.label : x.label) === key).map((x) => ({ p, x })));
    if (others.length)
      items.push({
        code: "wire.continues",
        level: "info",
        message: `Wire ${w.label}: the same circuit continues in ${others.length} other segment${others.length === 1 ? "" : "s"} (${[...new Set(others.map((o) => where(o.p.id)))].join(", ")})`,
        refs: others.slice(0, 12).map((o) => ({ pageId: o.p.id, id: o.x.id, text: `${o.x.label} · ${where(o.p.id)}`, kind: "wire" })),
      });
  }
  const cores = wires.filter((w) => w.cable && w.core);
  if (cores.length) items.push({ code: "cable.core", level: "info", message: `Frees ${cores.map((w) => `core ${w.core} of cable ${w.cable}`).join(", ")}`, refs: [] });

  // connections the deletion breaks (project-wide: through other sheets as well)
  const before = projectNets(doc, idx);
  const after = structuredClone(doc);
  const ap = after.pages.find((p) => p.id === page.id)!;
  deleteSelection(after, ap, sel);
  const afterNets = projectNets(after);
  const broken: string[] = [];
  const pinText = (el: string, pin: string) => {
    const x = idx.get(el);
    const p = x?.def?.pins.find((q) => q.id === pin);
    return `${x ? elText(doc, x.e) : "?"}:${p?.number || p?.name || "?"}`;
  };
  for (const n of before.nets) {
    const alive = n.pins.filter((p) => !delEls.has(p.el));
    if (alive.length < 2) continue;
    const groups = new Map<unknown, typeof alive>();
    for (const p of alive) {
      const m = afterNets.netOfPin.get(`${p.el}/${p.pin}`) ?? `solo:${p.el}/${p.pin}`;
      groups.set(m, [...(groups.get(m) ?? []), p]);
    }
    if (groups.size < 2) continue;
    const parts = [...groups.values()].map((g) => g.slice(0, 3).map((p) => pinText(p.el, p.pin)).join(", ") + (g.length > 3 ? "…" : ""));
    broken.push(parts.join("  ⟷  "));
  }
  if (broken.length)
    items.push({
      code: "net.split",
      level: "warning",
      message: `Breaks ${broken.length} connection${broken.length === 1 ? "" : "s"}: ${broken.slice(0, 4).join("; ")}${broken.length > 4 ? ` … and ${broken.length - 4} more` : ""}`,
      refs: [],
    });

  /* ---------- comments ---------- */
  const anchored = (opts.comments ?? []).filter((c) => (c.status === "OPEN" || c.status === "REOPENED") && c.anchor?.id && (delEls.has(c.anchor.id) || delWires.has(c.anchor.id)));
  if (anchored.length)
    items.push({ code: "comments", level: "info", message: `${anchored.length} open review comment${anchored.length === 1 ? " is" : "s are"} attached here — they stay, pinned to the spot`, refs: anchored.map((c) => ({ pageId: c.pageId ?? page.id, id: c.id, text: c.body.split("\n")[0].slice(0, 60), kind: "comment" })) });

  // references that disappear completely (for closing gaps)
  const remaining = new Set<string>();
  for (const [id, { e }] of idx) if (!delEls.has(id) && e.info.label) remaining.add(e.info.label.trim());
  const freedRefs = [...new Set(els.map((e) => e.info.label?.trim()).filter((l): l is string => !!l && !remaining.has(l)))];

  return { items, freedRefs, counts: { elements: els.length, wires: wires.length, other: sel.junctions.length + sel.texts.length + (sel.shapes?.length ?? 0) } };
}

function groupByPage(els: { pageId: string; id: string }[], ws: { pageId: string; id: string }[] = []) {
  const m = new Map<string, { pageId: string; elements: string[]; wires: string[] }>();
  for (const x of els) {
    if (!m.has(x.pageId)) m.set(x.pageId, { pageId: x.pageId, elements: [], wires: [] });
    m.get(x.pageId)!.elements.push(x.id);
  }
  for (const x of ws) {
    if (!m.has(x.pageId)) m.set(x.pageId, { pageId: x.pageId, elements: [], wires: [] });
    m.get(x.pageId)!.wires.push(x.id);
  }
  return [...m.values()];
}

/** Does deleting this need the user's attention (anything used elsewhere or a broken connection)? */
export const needsConfirmation = (i: DeleteImpact) => i.items.some((x) => x.level === "warning" || x.code === "ref.shared" || x.code === "wire.continues" || x.code === "xref.mate" || x.code === "comments");

/** Delete the selection plus related items on any sheet. */
export function deleteWithRelated(doc: Doc, pageId: string, sel: Sel, related: NonNullable<ImpactItem["related"]>) {
  const byPage = new Map<string, Sel>();
  const get = (pid: string) => {
    if (!byPage.has(pid)) byPage.set(pid, { elements: [], wires: [], junctions: [], texts: [], shapes: [] });
    return byPage.get(pid)!;
  };
  const s0 = get(pageId);
  s0.elements.push(...sel.elements);
  s0.wires.push(...sel.wires);
  s0.junctions.push(...sel.junctions);
  s0.texts.push(...sel.texts);
  s0.shapes = [...(s0.shapes ?? []), ...(sel.shapes ?? [])];
  for (const r of related) {
    const s = get(r.pageId);
    s.elements.push(...(r.elements ?? []));
    s.wires.push(...(r.wires ?? []));
    s.junctions.push(...(r.junctions ?? []));
  }
  for (const [pid, s] of byPage) {
    const p = doc.pages.find((x) => x.id === pid);
    if (p) deleteSelection(doc, p, { ...s, elements: [...new Set(s.elements)], wires: [...new Set(s.wires)] });
  }
}

/* ------------------------------------------------------------------ */
/* Closing gaps in references                                           */
/* ------------------------------------------------------------------ */

const parseRef = (ref: string) => {
  const m = /^(.*?)(\d+)$/.exec(ref);
  return m ? { prefix: m[1], n: Number(m[2]), width: m[2].length, padded: m[2].length > 1 && m[2].startsWith("0") } : null;
};

/**
 * Renumber references so each prefix runs without gaps, keeping their order (K1, K2, K4, K7 →
 * K1, K2, K3, K4). Every element carrying a reference (coil, its contacts, other representations)
 * is renamed together. Locked references keep their number and are skipped over. Terminals
 * ("X1:3") are left to the terminal strip editor. `prefixes`: only these groups (default: all).
 */
export function planCloseGaps(doc: Doc, prefixes?: string[]): RefChange[] {
  const want = prefixes ? new Set(prefixes) : null;
  const groups = new Map<string, { label: string; n: number; width: number; padded: boolean; locked: boolean; start: number }[]>();
  const seen = new Set<string>();
  for (const p of doc.pages)
    for (const e of p.elements) {
      const label = e.info.label?.trim();
      if (!label || label.includes(":")) continue;
      const def = doc.defs[e.defId];
      if (!def || isReport(def.linkType) || def.name === "volt_junction" || isTerminal(def)) continue;
      const r = parseRef(label);
      if (!r || (want && !want.has(r.prefix))) continue;
      const g = groups.get(r.prefix) ?? [];
      const ex = g.find((x) => x.label === label);
      if (ex) ex.locked ||= !!e.refLocked;
      else if (!seen.has(label)) g.push({ label, n: r.n, width: r.width, padded: r.padded, locked: !!e.refLocked, start: ruleFor(doc, def)?.start ?? 1 });
      seen.add(label);
      groups.set(r.prefix, g);
    }
  const rename = new Map<string, string>();
  for (const [prefix, g] of groups) {
    g.sort((a, b) => a.n - b.n);
    const lockedNums = new Set(g.filter((x) => x.locked).map((x) => x.n));
    let n = Math.min(g[0]?.start ?? 1, g[0]?.n ?? 1);
    for (const x of g) {
      if (x.locked) continue;
      while (lockedNums.has(n)) n++;
      if (n < x.n) {
        const num = x.padded ? String(n).padStart(x.width, "0") : String(n);
        rename.set(x.label, `${prefix}${num}`);
      } else n = x.n;
      n++;
    }
  }
  const out: RefChange[] = [];
  for (const p of doc.pages) for (const e of p.elements) {
    const l = e.info.label?.trim();
    if (l && rename.has(l)) out.push({ pageId: p.id, elId: e.id, from: l, to: rename.get(l)! });
  }
  return out;
}

export function applyRefChanges(doc: Doc, ch: RefChange[]) {
  for (const c of ch) {
    const e = doc.pages.find((p) => p.id === c.pageId)?.elements.find((x) => x.id === c.elId);
    if (e) e.info.label = c.to;
  }
}
