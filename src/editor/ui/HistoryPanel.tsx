"use client";
/**
 * Version control (git-like): uncommitted changes of the working copy, commit with a message,
 * history of commits across versions (versions are tags, variants are branches), view / compare /
 * restore any commit, start a new version from an older commit, and the session's undo history.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitCompare, ExternalLink, Undo2, GitCommitHorizontal, GitBranch, Tag, RotateCcw, GitBranchPlus, ChevronDown, ChevronRight, Check } from "lucide-react";
import { useEditor } from "../store";
import { useEditorUI } from "./context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status";
import { Badge, Spinner } from "@/components/ui/misc";
import { PromptDialog } from "@/components/volt/common";
import { api } from "@/lib/fetcher";
import { relTime, cn, fmtDate } from "@/lib/utils";
import { diffDocs, type Change, type DocDiff } from "@/core/diff";
import { emptySel } from "@/core/ops";
import type { Doc } from "@/core/model";

export type VersionRow = { id: string; label: string; status: string; summary: string; createdAt: string; createdBy: string; parentLabel?: string | null };

type Stats = { added: number; removed: number; changed: number; moved: number; total: number };
type Entry =
  | { type: "commit"; id: string; seq: number; kind: string; message: string; author: string; createdAt: string; stats: Stats; versionId: string; versionLabel: string; branch: string; tags: { label: string; status: string }[]; current: boolean; head: boolean }
  | { type: "version"; id: string; versionId: string; versionLabel: string; status: string; summary: string; createdAt: string; author: string; branch: string };
type Hist = { history: Entry[]; head: string | null; baseline: { kind: string; id: string | null; label: string }; canCommit: boolean };
type MiniChange = Pick<Change, "kind" | "area" | "pageId" | "id" | "label" | "details">;

const TONE: Record<Change["kind"], string> = { added: "text-success", removed: "text-danger", changed: "text-warning", moved: "text-accent" };
const SIGN: Record<Change["kind"], string> = { added: "+", removed: "−", changed: "~", moved: "↔" };

/** empty drawing for the first commit of a project */
const emptyOf = (d: Doc): Doc => ({ ...d, meta: { title: d.meta.title, props: {} }, pages: [], defs: {}, cables: [], terminalStrips: [] });

/** copy `target` into the working copy as one undoable change */
export function restoreInto(target: Doc, label: string) {
  return useEditor.getState().apply(label, (d) => {
    const t = structuredClone(target) as unknown as Record<string, unknown>;
    const dd = d as unknown as Record<string, unknown>;
    for (const k of Object.keys(dd)) if (!(k in t) && k !== "qet") delete dd[k];
    for (const [k, v] of Object.entries(t)) dd[k] = v;
  });
}

export function locateChange(c: Pick<Change, "area" | "pageId" | "id">, ui: ReturnType<typeof useEditorUI>, old?: Doc) {
  const s = useEditor.getState();
  if (c.pageId && c.pageId !== s.pageId && s.doc.pages.some((p) => p.id === c.pageId)) s.setPage(c.pageId);
  requestAnimationFrame(() => {
    if (!c.id) return;
    const page = useEditor.getState().page();
    if (c.area === "element" && page.elements.some((e) => e.id === c.id)) useEditor.getState().setSel({ ...emptySel(), elements: [c.id] });
    else if (c.area === "wire" && page.wires.some((w) => w.id === c.id)) useEditor.getState().setSel({ ...emptySel(), wires: [c.id] });
    else if (c.area === "text" && page.texts.some((t) => t.id === c.id)) useEditor.getState().setSel({ ...emptySel(), texts: [c.id] });
    else {
      const gone = old?.pages.find((p) => p.id === c.pageId)?.elements.find((e) => e.id === c.id);
      if (gone) ui.engine.current?.centerOn(gone, 2);
      return;
    }
    ui.engine.current?.zoomToSelection();
  });
}

export function HistoryPanel() {
  const v = useEditor((s) => s.version);
  const doc = useEditor((s) => s.doc);
  const save = useEditor((s) => s.save);
  const ui = useEditorUI();
  const router = useRouter();
  const [hist, setHist] = useState<Hist | null>(null);
  const [base, setBase] = useState<{ doc: Doc | null; label: string } | null>(null);
  const [dirty, setDirty] = useState<DocDiff | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, MiniChange[]>>({});
  const [showChanges, setShowChanges] = useState(true);
  const [branchFrom, setBranchFrom] = useState<Entry | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<{ doc: Doc; label: string } | null>(null);

  const load = useCallback(async () => {
    if (!v) return;
    try {
      const [h, b] = await Promise.all([api<Hist>(`/api/versions/${v.versionId}/commits`), api<{ doc: Doc | null; label: string }>(`/api/versions/${v.versionId}/baseline`)]);
      setHist(h);
      setBase(b);
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    }
  }, [v?.versionId, ui]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
  }, [load]);

  // uncommitted changes, recomputed shortly after editing stops
  useEffect(() => {
    if (!base) return;
    const t = setTimeout(() => setDirty(diffDocs(base.doc ?? emptyOf(doc), doc)), 400);
    return () => clearTimeout(t);
  }, [base, doc]);

  const commit = async () => {
    if (!v || !msg.trim()) return;
    setBusy(true);
    try {
      await ui.saveNow();
      const c = await api<{ seq: number }>(`/api/versions/${v.versionId}/commits`, { method: "POST", json: { message: msg } });
      ui.toast(`Committed #${c.seq}`);
      setMsg("");
      await load();
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const showCommit = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (!detail[id]) {
      const j = await api<{ stats: { items?: MiniChange[] } }>(`/api/commits/${id}`).catch(() => null);
      setDetail((d) => ({ ...d, [id]: j?.stats.items ?? [] }));
    }
  };
  const fetchDoc = async (e: Entry): Promise<{ doc: Doc }> => (e.type === "commit" ? api<{ doc: Doc }>(`/api/commits/${e.id}/doc`) : api<{ doc: Doc }>(`/api/versions/${e.versionId}/doc`));
  const compare = async (e: Entry) => {
    try {
      const j = await fetchDoc(e);
      const d = diffDocs(j.doc, useEditor.getState().doc);
      useEditor.getState().set("diff", { doc: j.doc, diff: d, label: e.type === "commit" ? `#${e.seq}` : `v${e.versionLabel}`, mode: "overlay" });
    } catch (err) {
      ui.toast((err as Error).message, { tone: "error" });
    }
  };
  const restore = async (e: Entry) => {
    try {
      const j = await fetchDoc(e);
      setConfirmRestore({ doc: j.doc, label: e.type === "commit" ? `#${e.seq} “${e.message}”` : `v${e.versionLabel}` });
    } catch (err) {
      ui.toast((err as Error).message, { tone: "error" });
    }
  };

  if (!v) return null;
  const editable = !!hist?.canCommit;
  const n = dirty?.changes.length ?? 0;
  const branch = hist?.history.find((e) => e.versionId === v.versionId)?.branch ?? v.variant?.code ?? "main";
  return (
    <div>
      <section className="border-b border-border p-3">
        <div className="flex items-center gap-2 text-2xs text-muted">
          <GitBranch className="size-3.5" />
          <span className="font-mono font-semibold text-fg">{branch}</span>
          <span>·</span>
          <span>v{v.label}</span>
          <StatusBadge status={v.status} />
        </div>
        <button className="mt-2 flex w-full items-center gap-1 text-left text-xs font-semibold" onClick={() => setShowChanges((x) => !x)} aria-expanded={showChanges}>
          {showChanges ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {dirty === null ? "Changes" : n ? `${n} uncommitted change${n === 1 ? "" : "s"}` : "No uncommitted changes"}
          {base && <span className="ml-auto text-2xs font-normal text-subtle">vs {base.label}</span>}
        </button>
        {showChanges && dirty && n > 0 && (
          <>
            <div className="mt-1 flex gap-2 text-2xs">
              {(["added", "removed", "changed", "moved"] as const).map(
                (k) =>
                  dirty.summary[k] > 0 && (
                    <span key={k} className={TONE[k]}>
                      {SIGN[k]}
                      {dirty.summary[k]} {k}
                    </span>
                  ),
              )}
            </div>
            <ChangeList changes={dirty.changes} onPick={(c) => locateChange(c, ui, base?.doc ?? undefined)} />
          </>
        )}
        {editable && (
          <div className="mt-2 space-y-1.5">
            <Textarea
              rows={2}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder={n ? "Commit message — what and why (e.g. Add E-stop S2 at loading station)" : "Nothing to commit"}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
              }}
              disabled={!n}
              aria-label="Commit message"
            />
            <div className="flex items-center gap-1">
              <Button size="xs" variant="primary" disabled={busy || !n || !msg.trim()} onClick={commit}>
                {busy ? <Spinner /> : <Check />} Commit{n ? ` ${n} change${n === 1 ? "" : "s"}` : ""}
              </Button>
              {n > 0 && base?.doc && (
                <Button size="xs" variant="ghost" onClick={() => setConfirmRestore({ doc: base.doc!, label: base.label })} title="Throw away the uncommitted changes (can be undone)">
                  <RotateCcw /> Discard
                </Button>
              )}
              <span className="ml-auto text-2xs text-subtle">{save === "saved" ? "saved" : save === "dirty" || save === "saving" ? "saving…" : ""}</span>
            </div>
          </div>
        )}
      </section>

      <section className="border-b border-border">
        <h3 className="px-3 pt-3 text-2xs font-semibold uppercase tracking-wide text-subtle">History</h3>
        {!hist ? (
          <div className="flex justify-center p-4 text-subtle">
            <Spinner />
          </div>
        ) : (
          <ol className="relative p-1.5">
            {hist.history.map((e, i) => {
              const prev = hist.history[i - 1];
              return (
                <li key={e.id}>
                  {(!prev || prev.versionId !== e.versionId) && (
                    <p className="mt-1 flex items-center gap-1.5 px-2 pb-0.5 text-2xs text-subtle">
                      <GitBranch className="size-3" /> {e.branch} · v{e.versionLabel}
                    </p>
                  )}
                  {e.type === "commit" ? (
                    <div className={cn("group rounded-md px-2 py-1.5 hover:bg-hover/60", open === e.id && "bg-hover/60")}>
                      <button className="flex w-full items-start gap-2 text-left" onClick={() => showCommit(e.id)} aria-expanded={open === e.id}>
                        <GitCommitHorizontal className={cn("mt-0.5 size-3.5 shrink-0", e.head && e.current ? "text-accent" : "text-subtle")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{e.message}</span>
                          <span className="flex flex-wrap items-center gap-1.5 text-2xs text-subtle">
                            <span className="font-mono">#{e.seq}</span>
                            <span title={fmtDate(e.createdAt)}>
                              {e.author} · {relTime(e.createdAt)}
                            </span>
                            {e.stats.added > 0 && <span className="text-success">+{e.stats.added}</span>}
                            {e.stats.removed > 0 && <span className="text-danger">−{e.stats.removed}</span>}
                            {e.stats.changed > 0 && <span className="text-warning">~{e.stats.changed}</span>}
                            {e.stats.moved > 0 && <span className="text-accent">↔{e.stats.moved}</span>}
                            {e.kind === "SUBMIT" && <Badge className="!h-4">review</Badge>}
                          </span>
                          {e.tags.map((t) => (
                            <span key={t.label} className="mr-1 mt-0.5 inline-flex items-center gap-1 rounded bg-purple-500/10 px-1 text-[10px] font-semibold text-purple-600 dark:text-purple-300">
                              <Tag className="size-2.5" /> v{t.label} · {t.status.toLowerCase().replace("_", " ")}
                            </span>
                          ))}
                        </span>
                      </button>
                      {open === e.id && (
                        <div className="mt-1 pl-5">
                          {!detail[e.id] ? <Spinner /> : <ChangeList changes={detail[e.id]} onPick={(c) => locateChange(c, ui)} />}
                          <EntryActions e={e} editable={editable} onCompare={compare} onRestore={restore} onBranch={setBranchFrom} projectId={v.projectId} currentId={v.versionId} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="group rounded-md px-2 py-1.5 hover:bg-hover/60">
                      <div className="flex items-center gap-2">
                        <Tag className="size-3.5 text-purple-500" />
                        <span className="text-xs font-semibold">v{e.versionLabel}</span>
                        <StatusBadge status={e.status} />
                        <span className="ml-auto text-2xs text-subtle">{relTime(e.createdAt)}</span>
                      </div>
                      {e.summary && <p className="mt-0.5 line-clamp-2 pl-5 text-2xs text-muted">{e.summary}</p>}
                      <div className="pl-5">
                        <EntryActions e={e} editable={editable} onCompare={compare} onRestore={restore} onBranch={setBranchFrom} projectId={v.projectId} currentId={v.versionId} />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {!hist.history.length && <li className="px-2 py-3 text-2xs text-subtle">No commits yet. Commit your changes to start the history.</li>}
          </ol>
        )}
      </section>
      <SessionHistory />
      {confirmRestore && (
        <PromptDialog
          open
          onOpenChange={(o) => !o && setConfirmRestore(null)}
          title={`Restore ${confirmRestore.label}?`}
          description="The working copy becomes exactly that drawing. This is a normal change: undo reverts it and nothing is lost from the history. Commit afterwards to record it."
          confirmLabel="Restore"
          onConfirm={() => {
            restoreInto(confirmRestore.doc, `Restore ${confirmRestore.label}`);
            ui.toast(`Restored ${confirmRestore.label} — commit to record it`, { undo: true });
            setMsg(`Restore ${confirmRestore.label}`);
            setConfirmRestore(null);
          }}
        />
      )}
      {branchFrom && (
        <PromptDialog
          open
          onOpenChange={(o) => !o && setBranchFrom(null)}
          title={branchFrom.type === "commit" ? `New version from #${branchFrom.seq}` : `New version from v${branchFrom.versionLabel}`}
          description={`Starts a new draft in the ${branchFrom.branch} line from this point of the history. Only one draft per line can be open.`}
          confirmLabel="Start new version"
          reason
          reasonLabel="Summary of changes"
          onConfirm={async (summary) => {
            try {
              const j = await api<{ id: string; label: string }>(`/api/projects/${v.projectId}/versions`, {
                method: "POST",
                json: { parentId: branchFrom.versionId, summary, ...(branchFrom.type === "commit" ? { fromCommitId: branchFrom.id } : {}) },
              });
              ui.toast(`Version ${j.label} started`);
              router.push(`/projects/${v.projectId}/v/${j.id}`);
            } catch (err) {
              ui.toast((err as Error).message, { tone: "error" });
            }
          }}
        />
      )}
    </div>
  );
}

function EntryActions({ e, editable, onCompare, onRestore, onBranch, projectId, currentId }: { e: Entry; editable: boolean; onCompare: (e: Entry) => void; onRestore: (e: Entry) => void; onBranch: (e: Entry) => void; projectId: string; currentId: string }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <Button size="xs" variant="ghost" onClick={() => onCompare(e)} title="Show the differences against the working copy on the canvas">
        <GitCompare /> Compare
      </Button>
      {editable && (
        <Button size="xs" variant="ghost" onClick={() => onRestore(e)} title="Make the working copy this drawing (undoable)">
          <RotateCcw /> Restore
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => onBranch(e)} title="Start a new version from this point">
        <GitBranchPlus /> New version
      </Button>
      {e.versionId !== currentId && (
        <Button size="xs" variant="ghost" asChild>
          <Link href={`/projects/${projectId}/v/${e.versionId}`}>
            <ExternalLink /> Open v{e.versionLabel}
          </Link>
        </Button>
      )}
    </div>
  );
}

export function ChangeList({ changes, onPick }: { changes: MiniChange[]; onPick: (c: Pick<Change, "area" | "pageId" | "id">) => void }) {
  const [all, setAll] = useState(false);
  const list = all ? changes : changes.slice(0, 40);
  if (!changes.length) return <p className="py-1 text-2xs text-subtle">No drawing changes.</p>;
  return (
    <ul className="mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-panel">
      {list.map((c, i) => (
        <li key={i}>
          <button className="flex w-full items-start gap-1.5 border-b border-border px-2 py-1 text-left last:border-0 hover:bg-panel-2" onClick={() => onPick(c)} title={c.details?.join("\n")}>
            <span className={cn("w-3 shrink-0 font-mono text-xs font-semibold", TONE[c.kind])}>{SIGN[c.kind]}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-2xs">{c.label}</span>
              {c.details?.length ? <span className="block truncate text-[10px] text-subtle">{c.details.join(" · ")}</span> : null}
            </span>
          </button>
        </li>
      ))}
      {changes.length > 40 && !all && (
        <li>
          <button className="w-full px-2 py-1 text-2xs text-accent hover:underline" onClick={() => setAll(true)}>
            Show all {changes.length}
          </button>
        </li>
      )}
    </ul>
  );
}

function SessionHistory() {
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const [open, setOpen] = useState(false);
  const undoTo = (i: number) => {
    const s = useEditor.getState();
    const n = s.past.length - 1 - i;
    for (let k = 0; k < n; k++) useEditor.getState().undo();
  };
  const items = useMemo(() => [...past].reverse(), [past]);
  return (
    <section>
      <button className="flex w-full items-center gap-1 px-3 pt-3 text-2xs font-semibold uppercase tracking-wide text-subtle" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Undo history (this session) · {past.length}
      </button>
      {open && (
        <ul className="p-1.5">
          {[...future].reverse().map((e, i) => (
            <li key={"f" + i} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-subtle line-through">
              {e.label}
            </li>
          ))}
          {items.map((e, i) => {
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
      )}
    </section>
  );
}
