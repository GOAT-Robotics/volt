"use client";
import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner, Badge } from "@/components/ui/misc";
import { api } from "@/lib/fetcher";
import { fmtDate } from "@/lib/utils";
import type { Revision } from "../types";
import { ConfirmDialog, PreviewImg } from "./common";

export function RevisionsPanel({ id, current, approved, canRestore, dirty, onRestored, refreshKey }: { id: string; current: number; approved?: number | null; canRestore: boolean; dirty?: boolean; onRestored: () => void; refreshKey?: unknown }) {
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [restore, setRestore] = useState<number | null>(null);
  useEffect(() => {
    let off = false;
    api<{ revisions: Revision[] }>(`/api/library/elements/${id}/revisions`)
      .then((j) => !off && setRevs(j.revisions))
      .catch(() => !off && setRevs([]));
    return () => {
      off = true;
    };
  }, [id, current, refreshKey]);
  if (!revs)
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-1.5 p-2">
      {revs.map((r) => (
        <div key={r.revision} className="flex gap-2 rounded-lg border border-border bg-panel p-2">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-white p-1 dark:bg-panel-2">
            <PreviewImg id={id} rev={r.revision} className="max-h-12 max-w-12" alt={`Revision ${r.revision}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              Rev {r.revision}
              {r.revision === current && <Badge tone="accent">current</Badge>}
              {approved === r.revision && <Badge tone="success">approved</Badge>}
            </p>
            <p className="truncate text-2xs text-muted" title={r.note}>
              {r.note || "—"}
            </p>
            <p className="text-2xs text-subtle">
              {r.userName} · {fmtDate(r.createdAt)}
            </p>
          </div>
          {canRestore && r.revision !== current && (
            <Button size="icon-sm" variant="ghost" aria-label={`Restore revision ${r.revision}`} title="Restore this revision" onClick={() => setRestore(r.revision)}>
              <RotateCcw />
            </Button>
          )}
        </div>
      ))}
      {!revs.length && (
        <p className="flex items-center gap-1.5 p-3 text-2xs text-subtle">
          <History className="size-3.5" /> No revisions
        </p>
      )}
      <ConfirmDialog
        open={restore !== null}
        title={`Restore revision ${restore}?`}
        description={`The drawing of revision ${restore} is saved as a new revision ${current + 1}. Nothing is lost — you can go back again.${dirty ? " Your unsaved changes will be discarded." : ""}`}
        confirm="Restore"
        onClose={() => setRestore(null)}
        onConfirm={async () => {
          try {
            await api(`/api/library/elements/${id}/revisions`, { method: "POST", json: { restore } });
            toast.success(`Revision ${restore} restored`);
            setRestore(null);
            onRestored();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </div>
  );
}
