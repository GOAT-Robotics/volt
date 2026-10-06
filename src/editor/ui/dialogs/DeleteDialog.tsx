"use client";
/** Delete with impact: where the selection is used, what breaks, related items, closing numbering gaps. */
import { useMemo, useState } from "react";
import { AlertTriangle, Info, MapPin, Trash2 } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { emptySel, getPage, deleteSelection, type Sel } from "@/core/ops";
import { applyRefChanges, deleteImpact, deleteWithRelated, planCloseGaps, type DeleteImpact, type ImpactItem } from "@/core/impact";
import { applyWireNumbers, planWireNumbers } from "@/core/wirenumber";
import type { Doc } from "@/core/model";
import { mkSel } from "@/core/ops";

const prefixOf = (ref: string) => /^(.*?)(\d+)$/.exec(ref)?.[1] ?? null;

/** delete + optional related items + optional gap closing, as one undoable step */
export function performDelete(doc: Doc, pageId: string, sel: Sel, o: { related: NonNullable<ImpactItem["related"]>; closeGaps: string[] | null; renumberWires: boolean }) {
  if (o.related.length) deleteWithRelated(doc, pageId, sel, o.related);
  else deleteSelection(doc, getPage(doc, pageId), sel);
  let renamed = 0;
  if (o.closeGaps?.length) {
    const ch = planCloseGaps(doc, o.closeGaps);
    applyRefChanges(doc, ch);
    renamed = new Set(ch.map((c) => c.from)).size;
  }
  let wires = 0;
  if (o.renumberWires && doc.wireNumbering) {
    const p = planWireNumbers(doc, { mode: "all" });
    applyWireNumbers(doc, p);
    wires = p.changes.length;
  }
  return { renamed, wires };
}

export function closeGapsDefault(doc: Doc) {
  return doc.numbering.closeGapsOnDelete !== false;
}

export function DeleteDialog({ onClose, arg }: { onClose: () => void; arg?: { sel: Sel; impact?: DeleteImpact } }) {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const comments = useEditor((s) => s.comments);
  const ui = useEditorUI();
  const sel = arg?.sel ?? emptySel();
  const impact = useMemo(
    () => arg?.impact ?? deleteImpact(doc, getPage(doc, pageId), sel, { comments: comments.map((c) => ({ id: c.id, anchor: c.anchor, status: c.status, body: c.body, pageId: c.pageId })) }),
    [arg?.impact, doc, pageId, sel, comments],
  );
  const relatedItems = impact.items.filter((i) => i.related?.length);
  const [withRelated, setWithRelated] = useState<Record<string, boolean>>({});
  const [closeGaps, setCloseGaps] = useState(closeGapsDefault(doc));
  const [renumberWires, setRenumberWires] = useState(false);
  const prefixes = useMemo(() => [...new Set(impact.freedRefs.map(prefixOf).filter((p): p is string => !!p))], [impact.freedRefs]);
  const preview = useMemo(() => {
    if (!closeGaps || !prefixes.length) return [];
    const d = structuredClone(doc);
    const related = relatedItems.filter((i) => withRelated[i.code]).flatMap((i) => i.related!);
    if (related.length) deleteWithRelated(d, pageId, sel, related);
    else deleteSelection(d, getPage(d, pageId), sel);
    const ch = planCloseGaps(d, prefixes);
    return [...new Map(ch.map((c) => [c.from, c.to])).entries()];
  }, [closeGaps, prefixes, doc, pageId, sel, relatedItems, withRelated]);

  const goto = (pid: string, id: string, kind: string) => {
    const s = useEditor.getState();
    if (kind === "comment") {
      s.set("panels", { ...s.panels, right: "review" });
      s.set("activeComment", id);
      return;
    }
    if (pid !== s.pageId) s.setPage(pid);
    requestAnimationFrame(() => {
      useEditor.getState().setSel(kind === "wire" ? mkSel({ wires: [id] }) : mkSel({ elements: [id] }));
      ui.engine.current?.zoomToSelection();
    });
    onClose();
  };

  const run = () => {
    const related = relatedItems.filter((i) => withRelated[i.code]).flatMap((i) => i.related!);
    let res = { renamed: 0, wires: 0 };
    const n = impact.counts.elements + impact.counts.wires + impact.counts.other + related.reduce((a, r) => a + (r.elements?.length ?? 0) + (r.wires?.length ?? 0), 0);
    useEditor.getState().apply(`Delete ${n} object${n === 1 ? "" : "s"}`, (d) => {
      res = performDelete(d, pageId, sel, { related, closeGaps: closeGaps ? prefixes : null, renumberWires });
      if ((d.numbering.closeGapsOnDelete !== false) !== closeGaps && prefixes.length) d.numbering.closeGapsOnDelete = closeGaps;
    }, { sel: emptySel() });
    ui.toast(`Deleted ${n} object${n === 1 ? "" : "s"}${res.renamed ? ` · ${res.renamed} reference${res.renamed === 1 ? "" : "s"} renumbered` : ""}${res.wires ? ` · ${res.wires} wire numbers` : ""}`, { undo: true });
    onClose();
  };

  const what = [impact.counts.elements && `${impact.counts.elements} component${impact.counts.elements === 1 ? "" : "s"}`, impact.counts.wires && `${impact.counts.wires} wire${impact.counts.wires === 1 ? "" : "s"}`, impact.counts.other && `${impact.counts.other} other item${impact.counts.other === 1 ? "" : "s"}`].filter(Boolean).join(", ");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Delete ${what || "selection"}?`} description="This is used elsewhere in the project. Check what happens before deleting — everything can be undone." wide>
        <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
          {impact.items.map((i, k) => (
            <li key={k} className={i.level === "warning" ? "rounded-md border border-warning/30 bg-warning-soft/50 p-2" : "rounded-md border border-border p-2"}>
              <p className="flex items-start gap-1.5 text-xs">
                {i.level === "warning" ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> : <Info className="mt-0.5 size-3.5 shrink-0 text-muted" />}
                <span>{i.message}</span>
              </p>
              {i.refs.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1 pl-5">
                  {i.refs.slice(0, 10).map((r) => (
                    <button key={r.id} className="inline-flex items-center gap-1 rounded border border-border bg-panel px-1.5 py-0.5 text-2xs hover:bg-hover" onClick={() => goto(r.pageId, r.id, r.kind)} title="Show">
                      <MapPin className="size-3" />
                      {r.text}
                    </button>
                  ))}
                  {i.refs.length > 10 && <span className="text-2xs text-subtle">+{i.refs.length - 10} more</span>}
                </div>
              )}
              {i.related?.length ? (
                <label className="mt-1.5 flex items-center gap-2 pl-5 text-2xs">
                  <Checkbox checked={!!withRelated[i.code]} onCheckedChange={(v) => setWithRelated((x) => ({ ...x, [i.code]: !!v }))} />
                  {i.code === "wires.dangling"
                    ? "Delete these wires too"
                    : i.code === "xref.slaves"
                      ? "Delete the contacts too"
                      : i.code === "xref.report"
                        ? "Delete the counterpart arrow too"
                        : i.code === "xref.mate"
                          ? "Delete the mating connector too"
                          : i.code === "block.partial"
                            ? "Delete the whole block instance"
                            : "Delete these too"}
                </label>
              ) : null}
            </li>
          ))}
        </ul>
        {(prefixes.length > 0 || doc.wireNumbering) && (
          <div className="mt-3 space-y-1.5 rounded-md border border-border bg-panel-2 p-2 text-xs">
            {prefixes.length > 0 && (
              <label className="flex items-start gap-2">
                <Checkbox checked={closeGaps} onCheckedChange={(v) => setCloseGaps(!!v)} className="mt-0.5" />
                <span>
                  Renumber references to close the gap ({impact.freedRefs.join(", ")} will be free)
                  {preview.length > 0 && <span className="block font-mono text-2xs text-muted">{preview.slice(0, 8).map(([a, b]) => `${a}→${b}`).join("  ")}{preview.length > 8 ? " …" : ""}</span>}
                </span>
              </label>
            )}
            {doc.wireNumbering && (
              <label className="flex items-start gap-2">
                <Checkbox checked={renumberWires} onCheckedChange={(v) => setRenumberWires(!!v)} className="mt-0.5" />
                <span>
                  Renumber all wires in order
                  <span className="block text-2xs text-muted">Closes gaps in wire numbers — printed sleeves and harness labels would change.</span>
                </span>
              </label>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} autoFocus>
            <Trash2 /> Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
