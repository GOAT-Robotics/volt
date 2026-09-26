"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, Info, ShieldCheck, RefreshCw } from "lucide-react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { validateDoc, type Issue, type IssueLevel } from "@/core/validate";
import { measureText } from "@/core/render/canvas";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { emptySel } from "@/core/ops";

const ICON: Record<IssueLevel, React.ReactNode> = {
  error: <AlertCircle className="size-3.5 text-danger" />,
  warning: <AlertTriangle className="size-3.5 text-warning" />,
  info: <Info className="size-3.5 text-accent" />,
};

export function ValidationPanel() {
  const doc = useEditor((s) => s.doc);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [lib, setLib] = useState<Record<string, { revision: number; status: string } | null>>({});
  const [filter, setFilter] = useState<IssueLevel | "all">("all");
  const [tick, setTick] = useState(0);
  const ui = useEditorUI();

  useEffect(() => {
    const ids = [...new Set(Object.values(doc.defs).map((d) => d.source?.libraryElementId).filter(Boolean))] as string[];
    if (!ids.length) return;
    fetch(`/api/library/status?ids=${ids.join(",")}`)
      .then((r) => (r.ok ? r.json() : { items: {} }) as Promise<{ items?: Record<string, { revision: number; status: string } | null> }>)
      .then((j) => setLib(j.items ?? {}))
      .catch(() => {});
  }, [doc.defs, tick]);

  useEffect(() => {
    const t = setTimeout(() => setIssues(validateDoc(doc, { library: lib, measure: measureText })), 300);
    return () => clearTimeout(t);
  }, [doc, lib, tick]);

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const i of issues ?? []) c[i.level]++;
    return c;
  }, [issues]);
  const shown = (issues ?? []).filter((i) => filter === "all" || i.level === filter);

  const locate = (i: Issue) => {
    const s = useEditor.getState();
    if (i.pageId && i.pageId !== s.pageId) s.setPage(i.pageId);
    const page = s.doc.pages.find((p) => p.id === (i.pageId ?? s.pageId));
    if (!page) return;
    const sel = emptySel();
    for (const id of i.ids) {
      if (page.elements.some((e) => e.id === id)) sel.elements.push(id);
      else if (page.wires.some((w) => w.id === id)) sel.wires.push(id);
    }
    requestAnimationFrame(() => {
      useEditor.getState().setSel(sel);
      ui.engine.current?.zoomToSelection();
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        {(["all", "error", "warning", "info"] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)} className={cn("flex h-6 items-center gap-1 rounded-md px-2 text-2xs", filter === k ? "bg-hover font-medium" : "text-subtle hover:bg-hover")}>
            {k !== "all" && ICON[k]}
            {k === "all" ? "All" : counts[k]}
          </button>
        ))}
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Re-run checks" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!issues ? null : !shown.length ? (
          <Empty icon={<ShieldCheck />} title="No issues found">
            Dangling wires, duplicate or missing references, unconnected required pins, overlapping labels and broken library links are checked as you work.
          </Empty>
        ) : (
          <ul>
            {shown.map((i, k) => (
              <li key={k}>
                <button onClick={() => locate(i)} className="flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left hover:bg-panel-2">
                  <span className="mt-0.5">{ICON[i.level]}</span>
                  <span className="text-xs leading-snug">{i.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="border-t border-border p-3 text-2xs leading-snug text-subtle">
        These are drawing-consistency checks. Passing them does not prove electrical safety, standards compliance or design correctness.
      </p>
    </div>
  );
}
