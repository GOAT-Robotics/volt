"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { GitCompare, ExternalLink, Undo2 } from "lucide-react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { relTime, cn } from "@/lib/utils";

export type VersionRow = { id: string; label: string; status: string; summary: string; createdAt: string; createdBy: string; parentLabel?: string | null };

export function HistoryPanel() {
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const v = useEditor((s) => s.version);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const ui = useEditorUI();
  useEffect(() => {
    if (!v) return;
    api<{ versions: VersionRow[] }>(`/api/projects/${v.projectId}/versions`)
      .then((j) => setVersions(j.versions))
      .catch(() => setVersions([]));
  }, [v]);
  const undoTo = (i: number) => {
    const s = useEditor.getState();
    const n = s.past.length - 1 - i;
    for (let k = 0; k < n; k++) useEditor.getState().undo();
  };
  return (
    <div>
      <section className="border-b border-border">
        <h3 className="px-3 pt-3 text-2xs font-semibold uppercase tracking-wide text-subtle">Versions</h3>
        {!versions ? (
          <div className="flex justify-center p-4 text-subtle">
            <Spinner />
          </div>
        ) : (
          <ul className="p-1.5">
            {versions.map((x) => (
              <li key={x.id} className={cn("group rounded-md px-2 py-1.5", x.id === v?.versionId && "bg-accent-soft")}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold tabular">v{x.label}</span>
                  <StatusBadge status={x.status} />
                  <span className="ml-auto text-2xs text-subtle">{relTime(x.createdAt)}</span>
                </div>
                {x.summary && <p className="mt-0.5 line-clamp-2 text-2xs text-muted">{x.summary}</p>}
                <div className="mt-1 flex gap-1 opacity-0 group-hover:opacity-100">
                  {x.id !== v?.versionId && (
                    <>
                      <Button size="xs" variant="ghost" onClick={() => ui.openDialog("compare", { versionId: x.id })}>
                        <GitCompare /> Compare
                      </Button>
                      <Button size="xs" variant="ghost" asChild>
                        <Link href={`/projects/${v?.projectId}/v/${x.id}`}>
                          <ExternalLink /> Open
                        </Link>
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="px-3 pt-3 text-2xs font-semibold uppercase tracking-wide text-subtle">Edit history (this session)</h3>
        <ul className="p-1.5">
          {[...future].reverse().map((e, i) => (
            <li key={"f" + i} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-subtle line-through">
              {e.label}
            </li>
          ))}
          {[...past].reverse().map((e, i) => {
            const idx = past.length - 1 - i;
            return (
              <li key={"p" + idx} className={cn("group flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover", i === 0 && "font-medium")}>
                <span className="truncate">{e.label}</span>
                <span className="ml-auto text-2xs text-subtle">{relTime(new Date(e.at))}</span>
                {i > 0 && (
                  <button className="text-subtle opacity-0 hover:text-fg group-hover:opacity-100" onClick={() => undoTo(idx)} aria-label={`Undo back to ${e.label}`} title="Undo back to here">
                    <Undo2 className="size-3" />
                  </button>
                )}
              </li>
            );
          })}
          {!past.length && !future.length && <li className="px-2 py-3 text-2xs text-subtle">No edits yet.</li>}
        </ul>
      </section>
    </div>
  );
}
