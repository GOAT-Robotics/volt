"use client";
import { useState } from "react";
import { Plus, FileText, MoreHorizontal, Copy, Trash2, ArrowLeft, ArrowRight, Settings2, Archive } from "lucide-react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { runCommand } from "./commands";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { uid } from "@/core/ids";
import type { Doc } from "@/core/model";
import { PagePeers } from "./LivePresence";

export function reorderPages(d: Doc, id: string, dir: -1 | 1) {
  const pages = [...d.pages].sort((a, b) => a.order - b.order);
  const i = pages.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  pages.forEach((p, k) => {
    const dp = d.pages.find((x) => x.id === p.id)!;
    dp.order = k;
  });
}

export function duplicatePage(d: Doc, id: string): string {
  const src = d.pages.find((p) => p.id === id);
  if (!src) return id;
  const copy = JSON.parse(JSON.stringify(src)) as typeof src;
  const map = new Map<string, string>();
  copy.id = uid();
  copy.title = src.title + " (copy)";
  copy.qet = undefined;
  for (const e of copy.elements) {
    const n = uid();
    map.set(e.id, n);
    e.id = n;
    e.qet = undefined;
  }
  for (const j of copy.junctions) {
    const n = uid();
    map.set(j.id, n);
    j.id = n;
  }
  for (const w of copy.wires) {
    w.id = uid();
    w.qet = undefined;
    for (const k of ["a", "b"] as const) {
      const e = w[k];
      if (e.k === "pin") e.el = map.get(e.el) ?? e.el;
      if (e.k === "junction") e.j = map.get(e.j) ?? e.j;
    }
  }
  for (const t of copy.texts) (t.id = uid()), (t.qet = undefined);
  for (const p of d.pages) if (p.order > src.order) p.order++;
  copy.order = src.order + 1;
  d.pages.push(copy);
  return copy.id;
}

export function PageTabs() {
  const pages = useEditor((s) => s.doc.pages);
  const pageId = useEditor((s) => s.pageId);
  const editable = useEditor((s) => !!s.version?.editable);
  const ui = useEditorUI();
  const [renaming, setRenaming] = useState<string | null>(null);
  const sorted = [...pages].filter((p) => !p.archived).sort((a, b) => a.order - b.order);
  const s = useEditor.getState;
  const rename = (id: string, title: string) => {
    setRenaming(null);
    const t = title.trim();
    if (!t) return;
    s().apply("Rename page", (d) => {
      const p = d.pages.find((x) => x.id === id);
      if (p) {
        p.title = t;
        if (p.titleBlock.fields.title === undefined || p.titleBlock.fields.title === "" || p.titleBlock.fields.title === pages.find((x) => x.id === id)?.title) p.titleBlock.fields.title = t;
      }
    });
  };
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border bg-panel px-1.5" role="tablist" aria-label="Pages">
      {sorted.map((p, i) => (
        <div
          key={p.id}
          role="tab"
          aria-selected={p.id === pageId}
          tabIndex={0}
          onClick={() => s().setPage(p.id)}
          onKeyDown={(e) => e.key === "Enter" && s().setPage(p.id)}
          onDoubleClick={() => editable && setRenaming(p.id)}
          className={cn(
            "group flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-2xs",
            p.id === pageId ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          <FileText className="size-3 opacity-60" />
          <span className="tabular text-subtle">{i + 1}</span>
          {renaming === p.id ? (
            <input
              autoFocus
              defaultValue={p.title}
              className="w-28 rounded border border-accent bg-panel px-1 text-2xs text-fg outline-none"
              onBlur={(e) => rename(p.id, e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") rename(p.id, (e.target as HTMLInputElement).value);
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <>
              <span className="max-w-40 truncate">{p.title}</span>
              <PagePeers pageId={p.id} />
            </>
          )}
          {editable && (
            <Menu>
              <MenuTrigger asChild>
                <button className="rounded p-0.5 opacity-0 hover:bg-hover group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`Page ${p.title} options`} onClick={(e) => e.stopPropagation()}>
                  <MoreHorizontal className="size-3" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => setRenaming(p.id)}>Rename</MenuItem>
                <MenuItem
                  onSelect={() => {
                    s().setPage(p.id);
                    runCommand("pageSettings", ui);
                  }}
                >
                  <Settings2 /> Page settings…
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    let nid = "";
                    s().apply("Duplicate page", (d) => {
                      nid = duplicatePage(d, p.id);
                    });
                    if (nid) s().setPage(nid);
                  }}
                >
                  <Copy /> Duplicate
                </MenuItem>
                <MenuItem disabled={i === 0} onSelect={() => s().apply("Move page", (d) => reorderPages(d, p.id, -1))}>
                  <ArrowLeft /> Move left
                </MenuItem>
                <MenuItem disabled={i === sorted.length - 1} onSelect={() => s().apply("Move page", (d) => reorderPages(d, p.id, 1))}>
                  <ArrowRight /> Move right
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  disabled={sorted.length < 2}
                  onSelect={() => {
                    const next = sorted[i === 0 ? 1 : i - 1];
                    s().apply("Archive page", (d) => {
                      const x = d.pages.find((q) => q.id === p.id);
                      if (x) x.archived = true;
                    });
                    s().setPage(next.id);
                    ui.toast(`Archived “${p.title}”`, { undo: true });
                  }}
                >
                  <Archive /> Archive
                </MenuItem>
                <MenuItem
                  danger
                  disabled={sorted.length < 2}
                  onSelect={() => {
                    if (!confirm(`Delete page “${p.title}” and everything on it?`)) return;
                    const next = sorted[i === 0 ? 1 : i - 1];
                    s().apply("Delete page", (d) => {
                      d.pages = d.pages.filter((q) => q.id !== p.id);
                    });
                    s().setPage(next.id);
                    ui.toast(`Deleted “${p.title}”`, { undo: true });
                  }}
                >
                  <Trash2 /> Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      ))}
      {editable && (
        <button onClick={() => runCommand("addPage", ui)} className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-fg" aria-label="Add page" title="Add page">
          <Plus className="size-3.5" />
        </button>
      )}
      <ArchivedPages />
    </div>
  );
}

function ArchivedPages() {
  const pages = useEditor((s) => s.doc.pages);
  const archived = pages.filter((p) => p.archived);
  const editable = useEditor((s) => !!s.version?.editable);
  if (!archived.length) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-2xs text-subtle hover:bg-hover">
          <Archive className="size-3" /> {archived.length} archived
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        {archived.map((p) => (
          <MenuItem
            key={p.id}
            disabled={!editable}
            onSelect={() =>
              useEditor.getState().apply("Restore page", (d) => {
                const x = d.pages.find((q) => q.id === p.id);
                if (x) x.archived = false;
              })
            }
          >
            Restore “{p.title}”
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
