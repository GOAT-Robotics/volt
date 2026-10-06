"use client";
/**
 * A one-pin terminal (end terminal, e.g. QElectroTech "borne_finale") has a single connection point,
 * so a wire cannot be drawn to its other side. Offer to swap it for a feed-through terminal (pin on
 * top and bottom) — this one or every one-pin terminal of the strip — keeping references and wires.
 */
import { useEffect, useMemo, useState } from "react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Doc, ElemInst, ElementDef, Page } from "@/core/model";
import { builtinTerminalDef, isTerminalDef, parseTerminalRef } from "@/core/terminals";
import { replaceSymbol } from "@/core/replace";
import { loadLibraryDef, type LibItem } from "../defs-client";

const isFeedThrough = (d: ElementDef) => isTerminalDef(d) && d.pins.length === 2 && d.pins.some((p) => p.orient === "n") && d.pins.some((p) => p.orient === "s");

export function TerminalSymbolFix({ e, doc, page, editable }: { e: ElemInst; doc: Doc; page: Page; editable: boolean }) {
  const ui = useEditorUI();
  const def = doc.defs[e.defId];
  const one = !!def && def.pins.length === 1;
  const [lib, setLib] = useState<ElementDef[]>([]);
  const [pick, setPick] = useState("");
  useEffect(() => {
    if (!one || !editable) return;
    let off = false;
    fetch(`/api/library/elements?${new URLSearchParams({ q: "terminal", kind: "ELEMENT", limit: "80" })}`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then(async (j: { items: LibItem[] }) => {
        const out: ElementDef[] = [];
        for (const it of j.items.slice(0, 40)) {
          try {
            const d = await loadLibraryDef(it);
            if (isFeedThrough(d)) out.push(d);
          } catch {
            /* skip */
          }
          if (out.length >= 12) break;
        }
        if (!off) setLib(out);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [one, editable]);
  const options = useMemo(() => {
    const m = new Map<string, ElementDef>();
    for (const d of Object.values(doc.defs)) if (isFeedThrough(d)) m.set(d.id, d);
    for (const d of lib) if (![...m.values()].some((x) => x.uuid === d.uuid)) m.set(d.id, d);
    const b = builtinTerminalDef();
    if (!m.has(b.id)) m.set(b.id, b);
    return [...m.values()];
  }, [doc.defs, lib]);
  if (!one || !editable) return null;
  const target = options.find((d) => d.id === pick) ?? options[0];
  const tag = parseTerminalRef(e.info.label ?? "").tag;
  const sameStrip = doc.pages.flatMap((p) => p.elements.map((x) => ({ p, x }))).filter(({ x }) => x.defId === e.defId && (!tag || parseTerminalRef(x.info.label ?? "").tag === tag));
  const run = (all: boolean) => {
    if (!target) return;
    let n = 0, loose = 0;
    useEditor.getState().apply(all ? `Feed-through terminals for ${tag || "strip"}` : "Feed-through terminal", (d) => {
      const list = all ? sameStrip.map(({ p, x }) => ({ pid: p.id, id: x.id })) : [{ pid: page.id, id: e.id }];
      for (const { pid, id } of list) {
        const pg = d.pages.find((q) => q.id === pid);
        const el = pg?.elements.find((q) => q.id === id);
        if (!pg || !el) continue;
        const r = replaceSymbol(d, pg, el, target);
        n++;
        loose += r.loose;
      }
    });
    ui.toast(`${n} terminal${n === 1 ? "" : "s"} now ${target.names.en ?? target.name} — wire the top and the bottom${loose ? ` (${loose} wire end${loose === 1 ? "" : "s"} left loose)` : ""}`, { undo: true });
  };
  return (
    <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/5 p-2 text-2xs">
      <p>
        <b>End terminal — one connection point.</b> This symbol has a pin only at the top, so nothing can be wired to its other side. Use a feed-through terminal (pin top and bottom); the reference and existing wires are kept (wires going down move to the bottom pin).
      </p>
      <NativeSelect value={target?.id ?? ""} onChange={(ev) => setPick(ev.target.value)} aria-label="Feed-through symbol" className="h-7 text-2xs">
        {options.map((d) => (
          <option key={d.id} value={d.id}>
            {d.names.en ?? d.name}
            {d.source?.libraryElementId ? " (library)" : d.id.startsWith("volt/") ? " (Volt)" : ""}
          </option>
        ))}
      </NativeSelect>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="primary" onClick={() => run(false)}>
          Replace this one
        </Button>
        {sameStrip.length > 1 && (
          <Button size="xs" variant="secondary" onClick={() => run(true)}>
            Replace all {sameStrip.length}
            {tag ? ` in ${tag}` : ""}
          </Button>
        )}
      </div>
    </div>
  );
}
