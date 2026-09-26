"use client";
import Link from "next/link";
import { ArrowLeft, Check, ChevronDown, CloudOff, Download, GitCompare, History, Loader2, Lock, Redo2, Search, Send, Undo2, AlertTriangle, Palette, Hash, Settings2, FileWarning, Plus, Command } from "lucide-react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { runCommand } from "./commands";
import { Button } from "@/components/ui/button";
import { Tip, Kbd } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, MenuLabel } from "@/components/ui/menu";
import { StatusBadge } from "@/components/ui/status";
import { relTime } from "@/lib/utils";

function SaveIndicator() {
  const save = useEditor((s) => s.save);
  const err = useEditor((s) => s.saveError);
  const at = useEditor((s) => s.lastSavedAt);
  const ui = useEditorUI();
  const map = {
    saved: { icon: <Check className="size-3" />, text: at ? `Saved ${relTime(new Date(at))}` : "All changes saved", cls: "text-subtle" },
    dirty: { icon: <span className="size-1.5 rounded-full bg-warning" />, text: "Unsaved changes", cls: "text-muted" },
    saving: { icon: <Loader2 className="size-3 animate-spin" />, text: "Saving…", cls: "text-muted" },
    error: { icon: <CloudOff className="size-3" />, text: "Save failed — retry", cls: "text-danger" },
    conflict: { icon: <AlertTriangle className="size-3" />, text: "Changed elsewhere", cls: "text-danger" },
    readonly: { icon: <Lock className="size-3" />, text: "Read-only", cls: "text-subtle" },
  }[save];
  return (
    <Tip content={err ?? map.text}>
      <button
        onClick={() => {
          if (save === "error") void ui.saveNow();
          if (save === "conflict" && confirm("This version was saved from another session. Reload to get the latest? Your unsaved changes here will be lost.")) location.reload();
        }}
        className={`flex h-6 items-center gap-1.5 rounded px-1.5 text-2xs ${map.cls} hover:bg-hover`}
        aria-live="polite"
      >
        {map.icon}
        {map.text}
      </button>
    </Tip>
  );
}

export function Header() {
  const v = useEditor((s) => s.version);
  const title = useEditor((s) => s.doc.meta.title);
  const canUndo = useEditor((s) => s.past.length > 0 && !!s.version?.editable);
  const canRedo = useEditor((s) => s.future.length > 0 && !!s.version?.editable);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const diff = useEditor((s) => s.diff);
  const ui = useEditorUI();
  const run = (id: string) => runCommand(id, ui);

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel px-2">
      <Tip content="Back to project">
        <Button asChild variant="ghost" size="icon">
          <Link href={v ? `/projects/${v.projectId}` : "/projects"} aria-label="Back to project">
            <ArrowLeft />
          </Link>
        </Button>
      </Tip>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-accent text-[11px] font-bold text-white">V</div>
        <Menu>
          <MenuTrigger asChild>
            <button className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover">
              <span className="truncate text-xs font-semibold">{v?.projectName ?? title}</span>
              <span className="text-subtle">/</span>
              <span className="text-xs font-medium text-muted">v{v?.label}</span>
              <ChevronDown className="size-3 text-subtle" />
            </button>
          </MenuTrigger>
          <MenuContent className="w-60">
            <MenuLabel>Project</MenuLabel>
            <MenuItem onSelect={() => run("projectProps")}>
              <Settings2 /> Project properties…
            </MenuItem>
            <MenuItem onSelect={() => run("styles")} shortcut="⌘⇧S">
              <Palette /> Global styles…
            </MenuItem>
            <MenuItem onSelect={() => run("numbering")}>
              <Hash /> Automatic numbering…
            </MenuItem>
            <MenuItem onSelect={() => run("compat")}>
              <FileWarning /> Compatibility report
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>Version</MenuLabel>
            <MenuItem onSelect={() => run("newVersion")}>
              <Plus /> Start new version…
            </MenuItem>
            <MenuItem onSelect={() => run("compare")}>
              <GitCompare /> Compare with…
            </MenuItem>
            <MenuItem onSelect={() => useEditor.getState().set("panels", { ...useEditor.getState().panels, right: "history" })}>
              <History /> History
            </MenuItem>
          </MenuContent>
        </Menu>
        {v && <StatusBadge status={v.status} />}
        {v && !v.editable && v.reason && <span className="hidden truncate text-2xs text-subtle lg:inline">{v.reason}</span>}
      </div>

      <div className="ml-1 flex items-center">
        <Tip content={undoLabel ? `Undo ${undoLabel}` : "Undo"} shortcut="⌘Z">
          <Button variant="ghost" size="icon" disabled={!canUndo} onClick={() => run("undo")} aria-label="Undo">
            <Undo2 />
          </Button>
        </Tip>
        <Tip content="Redo" shortcut="⇧⌘Z">
          <Button variant="ghost" size="icon" disabled={!canRedo} onClick={() => run("redo")} aria-label="Redo">
            <Redo2 />
          </Button>
        </Tip>
      </div>
      <SaveIndicator />

      <div className="flex-1" />

      {diff && (
        <div className="flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning-soft px-2 py-0.5 text-2xs text-warning">
          <GitCompare className="size-3" /> Comparing with v{diff.label}
          <button className="ml-1 font-medium underline" onClick={() => useEditor.getState().set("diff", null)}>
            Exit
          </button>
        </div>
      )}

      <button
        onClick={() => ui.openDialog("palette")}
        className="hidden h-7 w-60 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-panel-2 px-2 text-2xs text-subtle hover:border-border-strong md:flex"
      >
        <Search className="size-3" />
        <span className="truncate">Search commands & drawing…</span>
        <span className="ml-auto flex gap-0.5">
          <Kbd>
            <Command className="size-2.5" />
          </Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <Tip content="Compare versions">
        <Button variant="ghost" size="icon" onClick={() => run("compare")} aria-label="Compare versions">
          <GitCompare />
        </Button>
      </Tip>
      <Tip content="Export" shortcut="⌘E">
        <Button variant="ghost" size="icon" onClick={() => run("export")} aria-label="Export" disabled={v ? !v.canExport : false}>
          <Download />
        </Button>
      </Tip>
      {v?.editable ? (
        <Button variant="primary" size="sm" onClick={() => run("submit")}>
          <Send /> Submit for review
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => run("newVersion")}>
          <Plus /> New version
        </Button>
      )}
    </header>
  );
}
