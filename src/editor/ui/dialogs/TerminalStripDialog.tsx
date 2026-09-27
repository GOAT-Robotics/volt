"use client";
/**
 * Terminal strip editor: every strip of the project as a table — order, numbers, type, level,
 * bridges, spares, part numbers — with what each side of every terminal connects to. Edits apply
 * immediately (undoable); renumbering rewrites the terminals' references on the drawings.
 */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Crosshair, FileSpreadsheet, FileText, GripVertical, ListOrdered, Plus, SortAsc, Trash2, Download } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { runCommand } from "../commands";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Checkbox, Tip } from "@/components/ui/misc";
import { Commit } from "../Inspector";
import { mkSel } from "@/core/ops";
import { cn, downloadBlob } from "@/lib/utils";
import type { Doc, TerminalType } from "@/core/model";
import {
  TERMINAL_TYPES,
  PLAN_COLUMNS,
  addSpare,
  collectStrips,
  deleteStrip,
  moveToStrip,
  removeRow,
  renumberStrip,
  setOrder,
  setRow,
  setStrip,
  setTerminalNumber,
  terminalPlanCsv,
  terminalPlanRows,
  type StripView,
  type TerminalRowView,
} from "@/core/terminals";
import { buildXlsx } from "@/core/xlsx";
import { uid } from "@/core/ids";

const TYPE_TONE: Partial<Record<TerminalType, string>> = { pe: "bg-[#16a34a]/15 text-[#15803d]", neutral: "bg-[#2563eb]/15 text-[#1d4ed8]", fuse: "bg-warning-soft text-warning", disconnect: "bg-[#9333ea]/15 text-[#7e22ce]" };
const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 80) || "export";

export function TerminalStripDialog({ onClose, arg }: { onClose: () => void; arg?: { tag?: string } }) {
  const doc = useEditor((s) => s.doc);
  const v = useEditor((s) => s.version);
  const editable = useEditor((s) => !s.version || s.version.editable);
  const ui = useEditorUI();
  const views = useMemo(() => collectStrips(doc), [doc]);
  const [tag, setTag] = useState<string>(() => arg?.tag ?? views.find((x) => x.tag)?.tag ?? views[0]?.tag ?? "");
  const [newTag, setNewTag] = useState("");
  const [renum, setRenum] = useState<{ start: number; step: number; pad: number } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const view = views.find((x) => x.tag === tag) ?? null;
  const keys = view?.rows.map((r) => r.key) ?? [];

  const apply = (label: string, fn: (d: Doc) => void) => {
    try {
      useEditor.getState().apply(label, fn);
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    }
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= keys.length || from === to) return;
    const next = [...keys];
    const [k] = next.splice(from, 1);
    next.splice(to, 0, k);
    apply("Reorder terminals", (d) => setOrder(d, tag, next));
  };
  const goTo = (pageId: string, el: string) => {
    const s = useEditor.getState();
    if (s.pageId !== pageId) s.setPage(pageId);
    s.setSel(mkSel({ elements: [el] }));
    onClose();
    setTimeout(() => runCommand("zoomSel", ui), 60);
  };
  const title = `${v?.projectName ?? doc.meta.title}${v ? ` — v${v.label}` : ""}`;
  const exportPlan = async (fmt: "xlsx" | "csv" | "pdf", all: boolean) => {
    const tags = all ? undefined : [tag];
    const base = safe(`${v?.projectName ?? doc.meta.title}_v${v?.label ?? ""}_terminals${all ? "" : `_${tag}`}`);
    if (fmt === "csv") return downloadBlob(new Blob([terminalPlanCsv(doc, tags)], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
    const rows = terminalPlanRows(doc, tags);
    if (fmt === "xlsx") {
      const strips = [...new Set(rows.map((r) => r[0]))];
      const bytes = buildXlsx(
        strips.map((t) => ({ name: t || "No reference", title: [`Terminal strip ${t} — ${title}`], header: [...PLAN_COLUMNS], rows: rows.filter((r) => r[0] === t), widths: [8, 9, 20, 6, 8, 36, 36, 18, 8, 24] })),
        { title: `Terminal plan — ${title}` },
      );
      return downloadBlob(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${base}.xlsx`);
    }
    const [{ PDFDocument, StandardFonts }, { appendTerminalPlanPages }] = await Promise.all([import("pdf-lib"), import("@/core/render/bom-pdf")]);
    const pdf = await PDFDocument.create();
    pdf.setTitle(`Terminal plan — ${title}`);
    pdf.setCreator("Volt");
    const fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
    appendTerminalPlanPages(pdf, fonts, rows, { title, subtitle: new Date().toISOString().slice(0, 10) });
    downloadBlob(new Blob([(await pdf.save()) as BlobPart], { type: "application/pdf" }), `${base}.pdf`);
  };

  const others = views.filter((x) => x.tag && x.tag !== tag);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide="xl" className="max-w-[min(1400px,96vw)]" title="Terminal strips" description="Order, number and document the terminals of each strip. Changes apply to the drawing right away (⌘Z undoes).">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* strips */}
          <aside className="flex w-48 shrink-0 flex-col border-r border-border">
            <div className="flex-1 overflow-auto p-2">
              {views.length === 0 && <p className="p-2 text-2xs text-subtle">No terminals in this project yet. Place terminal symbols (Library → terminals) and give them a reference like X1.</p>}
              {views.map((x) => (
                <button key={x.tag || "_"} onClick={() => (setTag(x.tag), setRenum(null))} className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs", x.tag === tag ? "bg-accent-soft font-medium text-accent" : "hover:bg-hover")}>
                  <span className="truncate">{x.tag || <i className="text-subtle">No reference</i>}</span>
                  <span className="tabular text-2xs text-subtle">
                    {x.rows.length}
                    {x.rows.some((r) => !r.num) ? " · ?" : ""}
                  </span>
                </button>
              ))}
            </div>
            {editable && (
              <form
                className="flex gap-1 border-t border-border p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = newTag.trim();
                  if (!t) return;
                  if (views.some((x) => x.tag === t)) return ui.toast(`Strip ${t} already exists`, { tone: "error" });
                  apply("New terminal strip", (d) => void (d.terminalStrips = [...(d.terminalStrips ?? []), { id: uid(), tag: t, sep: ":", rows: [] }]));
                  setTag(t);
                  setNewTag("");
                }}
              >
                <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="New strip, e.g. X2" className="h-7 text-2xs" onKeyDown={(e) => e.stopPropagation()} aria-label="New strip name" />
                <Button size="icon-sm" variant="secondary" type="submit" aria-label="Add strip">
                  <Plus />
                </Button>
              </form>
            )}
          </aside>

          {/* selected strip */}
          <section className="flex min-w-0 flex-1 flex-col">
            {!view ? (
              <p className="p-6 text-xs text-subtle">Pick or create a strip.</p>
            ) : (
              <>
                {view.tag ? (
                  <div className="grid grid-cols-2 gap-2 border-b border-border p-3 sm:grid-cols-6">
                    <Field label="Strip">
                      <Commit value={view.tag} disabled={!editable} aria-label="Strip name" onCommit={(t) => t.trim() && t.trim() !== view.tag && (apply("Rename strip", (d) => setStrip(d, view.tag, { tag: t.trim() })), setTag(t.trim()))} />
                    </Field>
                    <Field label="Reference format">
                      <NativeSelect value={view.sep} disabled={!editable} onChange={(e) => apply("Terminal reference format", (d) => setStrip(d, view.tag, { sep: e.target.value }))} className="h-7 text-2xs">
                        <option value=":">{view.tag}:1</option>
                        <option value="-">{view.tag}-1</option>
                        <option value=".">{view.tag}.1</option>
                      </NativeSelect>
                    </Field>
                    <Field label="Description">
                      <Commit value={view.strip?.description ?? ""} disabled={!editable} placeholder="e.g. Field I/O" onCommit={(t) => apply("Strip description", (d) => setStrip(d, view.tag, { description: t }))} />
                    </Field>
                    <Field label="Location">
                      <Commit value={view.strip?.location ?? ""} disabled={!editable} placeholder="e.g. +CAB1 rail 2" onCommit={(t) => apply("Strip location", (d) => setStrip(d, view.tag, { location: t }))} />
                    </Field>
                    <Field label="Terminal part number">
                      <Commit value={view.strip?.partNumber ?? ""} disabled={!editable} placeholder="e.g. 3031212" onCommit={(t) => apply("Strip part number", (d) => setStrip(d, view.tag, { partNumber: t }))} />
                    </Field>
                    <Field label="Manufacturer">
                      <Commit value={view.strip?.manufacturer ?? ""} disabled={!editable} placeholder="e.g. Phoenix Contact" onCommit={(t) => apply("Strip manufacturer", (d) => setStrip(d, view.tag, { manufacturer: t }))} />
                    </Field>
                  </div>
                ) : (
                  <p className="border-b border-border p-3 text-2xs text-muted">These terminals have no reference yet. Move each one to a strip (last column); it gets that strip&apos;s next number.</p>
                )}

                {/* toolbar */}
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
                  {view.tag && editable && (
                    <>
                      <Button size="xs" variant="secondary" onClick={() => setRenum(renum ? null : { start: 1, step: 1, pad: 0 })}>
                        <ListOrdered /> Renumber…
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => apply("Sort terminals by number", (d) => setOrder(d, tag, [...keys].sort((a, b) => (a.startsWith("@") ? 1 : b.startsWith("@") ? -1 : a.replace(/^spare:/, "").localeCompare(b.replace(/^spare:/, ""), "en", { numeric: true })))))}
                      >
                        <SortAsc /> Sort by number
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => apply("Add spare terminal", (d) => void addSpare(d, tag, undefined, keys))}>
                        <Plus /> Spare terminal
                      </Button>
                    </>
                  )}
                  <span className="ml-auto flex items-center gap-1 text-2xs text-subtle">
                    <Download className="size-3.5" /> Terminal plan:
                    <Button size="xs" variant="ghost" onClick={() => exportPlan("xlsx", false)} disabled={!view.tag}>
                      <FileSpreadsheet /> Excel
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => exportPlan("pdf", false)} disabled={!view.tag}>
                      <FileText /> PDF
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => exportPlan("csv", false)} disabled={!view.tag}>
                      CSV
                    </Button>
                    <span className="mx-1 h-4 w-px bg-border" />
                    <Button size="xs" variant="ghost" onClick={() => exportPlan("xlsx", true)}>
                      All strips (Excel)
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => exportPlan("pdf", true)}>
                      All (PDF)
                    </Button>
                  </span>
                </div>
                {renum && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-border bg-hover/50 px-3 py-2 text-2xs">
                    Number all {view.rows.length} terminals in the order shown, starting at
                    <Input type="number" value={renum.start} onChange={(e) => setRenum({ ...renum, start: Number(e.target.value) || 0 })} className="h-6 w-16 text-2xs" onKeyDown={(e) => e.stopPropagation()} aria-label="Start" />
                    step
                    <Input type="number" value={renum.step} onChange={(e) => setRenum({ ...renum, step: Math.max(1, Number(e.target.value) || 1) })} className="h-6 w-14 text-2xs" onKeyDown={(e) => e.stopPropagation()} aria-label="Step" />
                    digits
                    <NativeSelect value={renum.pad} onChange={(e) => setRenum({ ...renum, pad: Number(e.target.value) })} className="h-6 w-20 text-2xs" aria-label="Digits">
                      <option value={0}>1, 2 …</option>
                      <option value={2}>01, 02 …</option>
                      <option value={3}>001 …</option>
                    </NativeSelect>
                    <span className="text-subtle">
                      → {view.tag}
                      {view.sep}
                      {String(renum.start).padStart(renum.pad, "0")}, {view.tag}
                      {view.sep}
                      {String(renum.start + renum.step).padStart(renum.pad, "0")} …
                    </span>
                    <Button size="xs" variant="primary" onClick={() => (apply(`Renumber ${tag}`, (d) => renumberStrip(d, tag, keys, renum)), setRenum(null))}>
                      Apply
                    </Button>
                  </div>
                )}

                {/* table */}
                <div className="min-h-0 flex-1 overflow-auto">
                  <table className="w-full text-2xs">
                    <thead className="sticky top-0 z-10 bg-panel">
                      <tr className="border-b border-border text-left text-subtle">
                        <th className="w-12 px-1 py-1.5" />
                        <th className="w-20 px-1 py-1.5 font-medium">Terminal</th>
                        <th className="w-36 px-1 py-1.5 font-medium">Type</th>
                        <th className="w-12 px-1 py-1.5 font-medium" title="Level of a multi-level terminal">Lvl</th>
                        <th className="w-12 px-1 py-1.5 font-medium" title="Bridged (jumpered) to the next terminal">Bridge</th>
                        <th className="px-1 py-1.5 font-medium">Side 1 · top / left</th>
                        <th className="px-1 py-1.5 font-medium">Side 2 · bottom / right</th>
                        <th className="w-28 px-1 py-1.5 font-medium">Part number</th>
                        <th className="w-16 px-1 py-1.5 font-medium">Sheet</th>
                        <th className="w-32 px-1 py-1.5 font-medium">Note</th>
                        <th className="w-28 px-1 py-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {view.rows.map((r, i) => (
                        <Row
                          key={r.key}
                          r={r}
                          i={i}
                          view={view}
                          next={view.rows[i + 1]}
                          editable={editable}
                          others={others}
                          dragging={drag === r.key}
                          onDrag={(k) => setDrag(k)}
                          onDrop={() => {
                            if (drag) move(keys.indexOf(drag), i);
                            setDrag(null);
                          }}
                          move={(d) => move(i, i + d)}
                          apply={apply}
                          goTo={goTo}
                        />
                      ))}
                      {!view.rows.length && (
                        <tr>
                          <td colSpan={11} className="px-3 py-6 text-center text-subtle">
                            No terminals on this strip yet. Give terminal symbols the reference {view.tag}
                            {view.sep}1, {view.tag}
                            {view.sep}2 …, move terminals here from another strip, or add spare terminals.
                            {editable && view.strip && (
                              <>
                                {" "}
                                <button className="text-danger hover:underline" onClick={() => (apply("Delete terminal strip", (d) => deleteStrip(d, view.tag)), setTag(views.find((x) => x.tag !== view.tag)?.tag ?? ""))}>
                                  Delete this strip
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-border px-3 py-1.5 text-[10px] text-subtle">
                  {view.rows.length} terminals · {view.rows.filter((r) => r.spare).length} spare · {view.rows.filter((r) => !r.num).length} unnumbered · Drag rows or use the arrows to reorder. The terminal number is written into the reference ({view.tag || "X1"}
                  {view.sep}3), so the drawing, cross-references, BOM and .qet export follow. Terminal types, levels, bridges and spares are stored with the project (not in .qet files).
                </p>
              </>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] text-subtle">{label}</span>
      {children}
    </label>
  );
}

function Row({
  r,
  i,
  view,
  next,
  editable,
  others,
  dragging,
  onDrag,
  onDrop,
  move,
  apply,
  goTo,
}: {
  r: TerminalRowView;
  i: number;
  view: StripView;
  next?: TerminalRowView;
  editable: boolean;
  others: StripView[];
  dragging: boolean;
  onDrag: (k: string | null) => void;
  onDrop: () => void;
  move: (d: number) => void;
  apply: (label: string, fn: (d: Doc) => void) => void;
  goTo: (pageId: string, el: string) => void;
}) {
  const tag = view.tag;
  const num = r.num;
  const rowEditable = editable && !!tag && !!num;
  const set = (label: string, p: Parameters<typeof setRow>[3]) => num && apply(label, (d) => setRow(d, tag, num, p));
  const sheets = [...new Map(r.instances.map((x) => [x.sheet, x])).values()];
  return (
    <tr
      className={cn("border-b border-border/60 align-top", dragging && "opacity-40", r.spare && "bg-hover/40", r.row?.bridge && "border-b-accent/50")}
      draggable={editable && !!tag}
      onDragStart={() => onDrag(r.key)}
      onDragEnd={() => onDrag(null)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <td className="px-1 py-1">
        <div className="flex items-center text-subtle">
          <GripVertical className={cn("size-3.5", editable && tag ? "cursor-grab" : "opacity-30")} />
          {editable && tag && (
            <div className="flex flex-col">
              <button className="hover:text-fg disabled:opacity-30" disabled={i === 0} onClick={() => move(-1)} aria-label="Move up">
                <ArrowUp className="size-3" />
              </button>
              <button className="hover:text-fg disabled:opacity-30" disabled={!next} onClick={() => move(1)} aria-label="Move down">
                <ArrowDown className="size-3" />
              </button>
            </div>
          )}
        </div>
      </td>
      <td className="px-1 py-1">
        {tag ? (
          <Commit
            value={num ?? ""}
            placeholder="?"
            disabled={!editable}
            className={cn("h-6 w-16 text-2xs font-medium", !num && "border-warning")}
            aria-label="Terminal number"
            onCommit={(n) => n.trim() && n.trim() !== num && apply("Terminal number", (d) => setTerminalNumber(d, tag, r.key, n))}
          />
        ) : (
          <span className="text-subtle">—</span>
        )}
      </td>
      <td className="px-1 py-1">
        <div className="flex items-center gap-1">
          <NativeSelect value={r.type} disabled={!rowEditable} onChange={(e) => set("Terminal type", { type: e.target.value === "feed" ? undefined : (e.target.value as TerminalType) })} className="h-6 text-2xs" aria-label="Terminal type">
            {TERMINAL_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
          {TYPE_TONE[r.type] && <span className={cn("rounded px-1 text-[9px] font-semibold", TYPE_TONE[r.type])}>{TERMINAL_TYPES.find((t) => t.id === r.type)!.short}</span>}
        </div>
        {r.spare ? <span className="text-[10px] text-subtle">spare · not drawn</span> : <span className="block truncate text-[10px] text-subtle" title={r.symbol}>{r.symbol}</span>}
      </td>
      <td className="px-1 py-1">
        <Commit value={r.row?.level ?? ""} type="number" min={1} max={4} disabled={!rowEditable} className="h-6 w-11 text-2xs" aria-label="Level" onCommit={(x) => set("Terminal level", { level: Number(x) > 0 ? Number(x) : undefined })} />
      </td>
      <td className="px-1 py-1.5">
        <Tip content={next ? `Bridge ${num ?? "this"} to ${next.num ?? "the next terminal"}` : "Last terminal"}>
          <span>
            <Checkbox checked={!!r.row?.bridge} disabled={!rowEditable || !next} onCheckedChange={(x) => set(x ? "Bridge terminals" : "Remove bridge", { bridge: !!x || undefined })} aria-label="Bridge to next" />
          </span>
        </Tip>
      </td>
      <td className="px-1 py-1.5">
        <Conns list={r.side1} />
      </td>
      <td className="px-1 py-1.5">
        <Conns list={r.side2} />
      </td>
      <td className="px-1 py-1">
        <Commit value={r.row?.partNumber ?? ""} placeholder={view.strip?.partNumber ?? ""} disabled={!rowEditable} className="h-6 text-2xs" aria-label="Part number" onCommit={(x) => set("Terminal part number", { partNumber: x.trim() || undefined })} />
      </td>
      <td className="px-1 py-1.5">
        <div className="flex flex-wrap gap-1">
          {sheets.map((x) => (
            <button key={x.sheet} className="inline-flex items-center gap-0.5 rounded bg-hover px-1 tabular hover:text-accent" onClick={() => goTo(x.pageId, x.el)} title="Show on the drawing">
              <Crosshair className="size-3" />
              {x.sheet}
            </button>
          ))}
        </div>
      </td>
      <td className="px-1 py-1">
        <Commit value={r.row?.note ?? ""} disabled={!rowEditable} className="h-6 text-2xs" aria-label="Note" onCommit={(x) => set("Terminal note", { note: x.trim() || undefined })} />
      </td>
      <td className="px-1 py-1">
        <div className="flex items-center gap-1">
          {editable && !r.spare && (others.length > 0 || !tag) && (
            <NativeSelect value="" onChange={(e) => e.target.value && apply("Move terminal to strip", (d) => void moveToStrip(d, tag, r.key, e.target.value))} className="h-6 w-24 text-2xs" aria-label="Move to strip">
              <option value="">Move to…</option>
              {others.map((o) => (
                <option key={o.tag} value={o.tag}>
                  {o.tag}
                </option>
              ))}
            </NativeSelect>
          )}
          {editable && r.spare && num && (
            <Button size="icon-sm" variant="ghost" aria-label="Remove spare" onClick={() => apply("Remove spare terminal", (d) => removeRow(d, tag, num))}>
              <Trash2 />
            </Button>
          )}
          {editable && tag && (
            <Tip content="Insert a spare terminal below">
              <Button size="icon-sm" variant="ghost" aria-label="Insert spare below" onClick={() => apply("Add spare terminal", (d) => void addSpare(d, tag, r.key, view.rows.map((x) => x.key)))}>
                <Plus />
              </Button>
            </Tip>
          )}
        </div>
      </td>
    </tr>
  );
}

function Conns({ list }: { list: string[] }) {
  if (!list.length) return <span className="text-subtle">—</span>;
  return (
    <ul className="space-y-0.5">
      {list.map((t) => (
        <li key={t} className="break-words">
          {t}
        </li>
      ))}
    </ul>
  );
}
