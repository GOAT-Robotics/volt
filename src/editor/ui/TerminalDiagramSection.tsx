"use client";
/** Page properties of a terminal diagram sheet: which strip, which terminals, split over sheets. */
import { useMemo } from "react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { Input, NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getPage } from "@/core/ops";
import { newPage } from "@/core/doc";
import type { Doc, Page } from "@/core/model";
import { collectStrips } from "@/core/terminals";
import { insertTerminalDiagram, terminalsPerSheet } from "@/core/render/terminal-diagram";
import { Row, Section } from "./Inspector";

export function TerminalDiagramSection({ page, doc, editable }: { page: Page; doc: Doc; editable: boolean }) {
  const s = useEditor.getState;
  const ui = useEditorUI();
  const views = useMemo(() => collectStrips(doc).filter((v) => v.tag), [doc]);
  const td = page.terminalDiagram ?? { tag: "" };
  const view = views.find((v) => v.tag === td.tag);
  const total = view?.rows.length ?? 0;
  const per = terminalsPerSheet(page);
  const upd = (label: string, fn: (t: NonNullable<Page["terminalDiagram"]>) => void) =>
    s().apply(label, (d) => {
      const p = getPage(d, page.id);
      p.terminalDiagram ??= { tag: "" };
      fn(p.terminalDiagram);
    });
  const sheets = doc.pages.filter((p) => p.kind === "terminals" && p.terminalDiagram?.tag === td.tag).length;
  return (
    <Section title="Terminal diagram" defaultOpen>
      <Row label="Strip">
        <NativeSelect value={td.tag} disabled={!editable} aria-label="Strip" onChange={(e) => upd("Terminal diagram strip", (t) => ((t.tag = e.target.value), delete t.from, delete t.to))}>
          <option value="">— choose —</option>
          {views.map((v) => (
            <option key={v.tag} value={v.tag}>
              {v.tag} ({v.rows.length})
            </option>
          ))}
        </NativeSelect>
      </Row>
      <Row label="Drawing">
        <div className="flex rounded-md border border-border p-0.5 text-2xs" role="radiogroup" aria-label="Drawing style">
          {([
            ["rail", "On DIN rail"],
            ["box", "Simple box"],
          ] as const).map(([v, l]) => (
            <button
              key={v}
              role="radio"
              aria-checked={(td.style ?? "rail") === v}
              disabled={!editable}
              className={(td.style ?? "rail") === v ? "flex-1 rounded bg-hover px-2 py-0.5 font-medium" : "flex-1 rounded px-2 py-0.5 text-subtle"}
              onClick={() => upd("Terminal diagram style", (t) => (v === "rail" ? delete t.style : (t.style = v)))}
            >
              {l}
            </button>
          ))}
        </div>
      </Row>
      {view && (
        <Row label="Terminals" hint={`Positions in strip order (1–${total}); empty “to” = to the end. About ${per} fit on one sheet.`}>
          <div className="flex items-center gap-1 text-2xs">
            <Input type="number" min={1} max={total} value={td.from ?? 1} disabled={!editable} onChange={(e) => upd("Terminal range", (t) => void (t.from = Math.max(1, Number(e.target.value) || 1)))} className="h-7 w-16" aria-label="From" />
            to
            <Input type="number" min={1} max={total} value={td.to ?? ""} placeholder="end" disabled={!editable} onChange={(e) => upd("Terminal range", (t) => (e.target.value ? (t.to = Number(e.target.value)) : delete t.to))} className="h-7 w-16" aria-label="To" />
          </div>
        </Row>
      )}
      {view && editable && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="secondary"
            title="Spread the strip over as many sheets as needed (this one and new ones after it)"
            onClick={() => {
              let ids: string[] = [];
              s().apply(`Split terminal diagram ${td.tag}`, (d) => void (ids = insertTerminalDiagram(d, td.tag, { afterPageId: page.id, newPage })));
              ui.toast(`Terminal diagram ${td.tag}: ${ids.length} sheet${ids.length === 1 ? "" : "s"}`, { undo: true });
            }}
          >
            {sheets > 1 || total > per ? "Re-split over sheets" : "Fit to sheets"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => ui.openDialog("terminals", { tag: td.tag })}>
            Open terminal strip…
          </Button>
        </div>
      )}
      <p className="text-2xs text-subtle">Generated from the schematic: terminals with references {td.tag || "X1"}:1, {td.tag || "X1"}:2 … wherever they are drawn, their wires, and the strip&apos;s bridges and types. Click a terminal to go to its symbol.</p>
    </Section>
  );
}
