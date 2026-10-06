"use client";
import * as D from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useMemo } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import type { DialogName } from "../context";
import { useEditorUI } from "../context";
import { COMMANDS, runCommand } from "../commands";
import { useEditor } from "../../store";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/misc";
import { emptySel } from "@/core/ops";
import { StylesDialog } from "./StylesDialog";
import { NumberingDialog } from "./NumberingDialog";
import dynamic from "next/dynamic";
const TerminalStripDialog = dynamic(() => import("./TerminalStripDialog").then((m) => m.TerminalStripDialog), { ssr: false });
const ExportDialog = dynamic(() => import("./ExportDialog").then((m) => m.ExportDialog), { ssr: false });
import { CompatDialog, PageDialog, ProjectPropsDialog, ConnectDialog } from "./MiscDialogs";
import { NewVersionDialog, SubmitDialog, CompareDialog, DiffDrawer } from "./WorkflowDialogs";
import { BlockDialog, CreateElementDialog } from "./LibraryDialogs";
import { WiringDialog } from "./WiringDialog";
import { TitleBlockEditor } from "./TitleBlockEditor";
import { WireNumberingDialog } from "./WireNumberingDialog";
const WireLabelsDialog = dynamic(() => import("./WireLabelsDialog").then((m) => m.WireLabelsDialog), { ssr: false });
import { DeleteDialog } from "./DeleteDialog";
import type { Sel } from "@/core/ops";
import type { DeleteImpact } from "@/core/impact";

export function Dialogs({ dialog, onClose }: { dialog: { name: DialogName; arg?: unknown } | null; onClose: () => void }) {
  const open = (n: DialogName) => dialog?.name === n;
  const props = (n: DialogName) => ({ open: open(n), onOpenChange: (o: boolean) => !o && onClose() });
  return (
    <>
      <Palette {...props("palette")} onClose={onClose} />
      {open("styles") && <StylesDialog onClose={onClose} />}
      {open("numbering") && <NumberingDialog onClose={onClose} />}
      {open("wiring") && <WiringDialog onClose={onClose} />}
      {open("wireNumbers") && <WireNumberingDialog onClose={onClose} />}
      {open("wireLabels") && <WireLabelsDialog onClose={onClose} arg={dialog?.arg as { scope?: "selection" | "page" | "all" | "cable" } | undefined} />}
      {open("delete") && <DeleteDialog onClose={onClose} arg={dialog?.arg as { sel: Sel; impact?: DeleteImpact } | undefined} />}
      {open("titleBlock") && <TitleBlockEditor onClose={onClose} arg={dialog?.arg as { template?: string } | undefined} />}
      {open("export") && <ExportDialog onClose={onClose} arg={dialog?.arg as { format?: "bom" } | undefined} />}
      {open("terminals") && <TerminalStripDialog onClose={onClose} arg={dialog?.arg as { tag?: string } | undefined} />}
      {open("compat") && <CompatDialog onClose={onClose} />}
      {open("page") && <PageDialog onClose={onClose} />}
      {open("projectProps") && <ProjectPropsDialog onClose={onClose} />}
      {open("connect") && <ConnectDialog onClose={onClose} />}
      {open("newVersion") && <NewVersionDialog onClose={onClose} />}
      {open("submit") && <SubmitDialog onClose={onClose} />}
      {open("compare") && <CompareDialog onClose={onClose} arg={dialog?.arg as { versionId?: string } | undefined} />}
      {open("block") && <BlockDialog onClose={onClose} />}
      {open("createElement") && <CreateElementDialog onClose={onClose} arg={dialog?.arg as { fromDef?: string } | undefined} />}
      <Dialog {...props("shortcuts")}>
        <DialogContent title="Keyboard shortcuts" wide>
          <Shortcuts />
        </DialogContent>
      </Dialog>
      <DiffDrawer />
    </>
  );
}

function Shortcuts() {
  const sections = useMemo(() => {
    const m = new Map<string, typeof COMMANDS>();
    for (const c of COMMANDS) if (c.keys) m.set(c.section, [...(m.get(c.section) ?? []), c]);
    return [...m.entries()];
  }, []);
  const extra = [
    ["Pan", "Space + drag / middle mouse / trackpad"],
    ["Zoom", "Wheel / pinch / ⌘ + / ⌘ −"],
    ["Box select (inside)", "Drag left → right"],
    ["Box select (crossing)", "Drag right → left"],
    ["Add to selection", "Shift + click"],
    ["Disable snapping", "Hold Alt"],
    ["Flip wire bend", "Space or / while wiring"],
    ["Remove last wire corner", "Backspace while wiring"],
    ["Finish wire dangling", "Enter / double-click / right-click"],
    ["Nudge", "Arrows (Shift = 50)"],
    ["Find in drawing", "⌘F"],
    ["Command palette", "⌘K"],
  ];
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {sections.map(([s, list]) => (
        <div key={s}>
          <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{s}</h4>
          {list.map((c) => (
            <div key={c.id} className="flex h-6 items-center justify-between text-xs">
              {c.label}
              <Kbd>{c.keys}</Kbd>
            </div>
          ))}
        </div>
      ))}
      <div>
        <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Canvas</h4>
        {extra.map(([a, b]) => (
          <div key={a} className="flex h-6 items-center justify-between gap-2 text-xs">
            {a}
            <span className="text-2xs text-muted">{b}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Palette({ open, onOpenChange, onClose }: { open: boolean; onOpenChange: (o: boolean) => void; onClose: () => void }) {
  const ui = useEditorUI();
  const s = useEditor.getState();
  const doc = useEditor((x) => x.doc);
  const items = useMemo(() => {
    if (!open) return [];
    const out: { id: string; label: string; sub: string; pageId: string; el?: string }[] = [];
    for (const p of doc.pages) {
      out.push({ id: "p" + p.id, label: p.title, sub: "Page", pageId: p.id });
      for (const e of p.elements) {
        const def = doc.defs[e.defId];
        if (!def || def.name === "volt_junction") continue;
        out.push({ id: "e" + e.id, label: `${e.info.label || def.name}`, sub: `${def.name} · ${p.title}`, pageId: p.id, el: e.id });
      }
      if (out.length > 3000) break;
    }
    return out;
  }, [open, doc]);
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <D.Content className="fixed left-1/2 top-[14vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-panel shadow-pop animate-in" aria-describedby={undefined}>
          <D.Title className="sr-only">Command palette</D.Title>
          <Command loop className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-3.5 text-subtle" />
              <Command.Input autoFocus placeholder="Type a command or search components…" className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="p-6 text-center text-xs text-subtle">No results</Command.Empty>
              <Command.Group heading="Commands">
                {COMMANDS.filter((c) => !c.enabled || c.enabled(s)).map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`${c.label} ${c.section}`}
                    onSelect={() => {
                      onClose();
                      setTimeout(() => runCommand(c.id, ui), 0);
                    }}
                    className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-xs data-[selected=true]:bg-hover"
                  >
                    <span className="w-16 text-2xs text-subtle">{c.section}</span>
                    {c.label}
                    {c.keys && <span className="ml-auto"><Kbd>{c.keys}</Kbd></span>}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Drawing">
                {items.map((it) => (
                  <Command.Item
                    key={it.id}
                    value={`${it.label} ${it.sub} ${it.id}`}
                    onSelect={() => {
                      onClose();
                      const st = useEditor.getState();
                      if (st.pageId !== it.pageId) st.setPage(it.pageId);
                      requestAnimationFrame(() => {
                        if (it.el) {
                          st.setSel({ ...emptySel(), elements: [it.el] });
                          ui.engine.current?.zoomToSelection();
                        } else ui.engine.current?.fit();
                      });
                    }}
                    className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-xs data-[selected=true]:bg-hover"
                  >
                    <span className="font-medium">{it.label}</span>
                    <span className="truncate text-2xs text-subtle">{it.sub}</span>
                    <CornerDownLeft className="ml-auto size-3 text-subtle opacity-0 [[data-selected=true]_&]:opacity-100" />
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
