"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Users, User, GitCompare, Loader2, ArrowRight, GripVertical, Paperclip } from "lucide-react";
import { useEditor } from "../../store";
import { useEditorUI } from "../context";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Field, NativeSelect } from "@/components/ui/input";
import { Avatar, Badge, Switch, Spinner } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { api } from "@/lib/fetcher";
import { diffDocs, type Change } from "@/core/diff";
import type { Doc } from "@/core/model";
import type { VersionRow } from "../HistoryPanel";
import { cn } from "@/lib/utils";
import { emptySel } from "@/core/ops";

export function NewVersionDialog({ onClose }: { onClose: () => void }) {
  const v = useEditor((s) => s.version);
  const ui = useEditorUI();
  const router = useRouter();
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  if (!v) return null;
  const create = async () => {
    setBusy(true);
    try {
      await ui.saveNow();
      const j = await api<{ id: string; label: string }>(`/api/projects/${v.projectId}/versions`, { method: "POST", json: { parentId: v.versionId, summary, description, ticket: ticket || undefined } });
      ui.toast(`Version ${j.label} created`);
      router.push(`/projects/${v.projectId}/v/${j.id}`);
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Start new version" description={`Creates an editable copy of v${v.label}. v${v.label} stays unchanged.`}>
        <div className="space-y-3">
          <Field label="Change summary (required)">
            <Input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Add second conveyor motor circuit" />
          </Field>
          <Field label="Detailed description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
          </Field>
          <Field label="Related ticket / work item">
            <Input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="e.g. ENG-1234" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!summary.trim() || busy} onClick={create}>
            {busy && <Loader2 className="animate-spin" />} Start new version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Reviewer = { kind: "user"; id: string; name: string; email?: string } | { kind: "group"; id: string; name: string };

export function SubmitDialog({ onClose }: { onClose: () => void }) {
  const v = useEditor((s) => s.version);
  const ui = useEditorUI();
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [q, setQ] = useState("");
  const [sugg, setSugg] = useState<Reviewer[]>([]);
  const [due, setDue] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sequential, setSequential] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<{ minApprovals: number; sequentialDefault: boolean; requireCommentsResolved: boolean; allowSelfApproval: boolean } | null>(null);
  useEffect(() => {
    api<{ approval: typeof policy }>("/api/workspace/policy")
      .then((j) => {
        setPolicy(j.approval);
        if (j.approval) setSequential(j.approval.sequentialDefault);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) return setSugg([]);
      const [u, g] = await Promise.all([
        api<{ users: { id: string; name: string; email: string }[] }>(`/api/users?q=${encodeURIComponent(q)}&role=review`).catch(() => ({ users: [] })),
        api<{ groups: { id: string; name: string }[] }>(`/api/groups?q=${encodeURIComponent(q)}`).catch(() => ({ groups: [] })),
      ]);
      setSugg([...u.users.map((x) => ({ kind: "user" as const, ...x })), ...g.groups.map((x) => ({ kind: "group" as const, ...x }))].filter((r) => !reviewers.some((x) => x.id === r.id)).slice(0, 8));
    }, 150);
    return () => clearTimeout(t);
  }, [q, reviewers]);
  if (!v) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await ui.saveNow();
      if (useEditor.getState().save !== "saved") throw new Error("Save the version before submitting");
      const j = await api<{ reviewId: string }>(`/api/versions/${v.versionId}/submit`, {
        method: "POST",
        json: { reviewers: reviewers.map((r) => (r.kind === "user" ? { userId: r.id } : { groupId: r.id, groupName: r.name })), dueDate: due || null, instructions, sequential, summary: undefined },
      });
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("ownerType", "REVIEW");
        fd.append("ownerId", j.reviewId);
        await fetch(`/api/projects/${v.projectId}/attachments`, { method: "POST", body: fd });
      }
      ui.toast("Submitted for review — this version is now frozen");
      setTimeout(() => location.reload(), 500);
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
      setBusy(false);
    }
  };
  const move = (i: number, d: number) => {
    const r = [...reviewers];
    const j = i + d;
    if (j < 0 || j >= r.length) return;
    [r[i], r[j]] = [r[j], r[i]];
    setReviewers(r);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Submit v${v.label} for review`} description="Submitting freezes this version. Further changes need a new version." wide>
        <div className="space-y-3">
          <Field label="Reviewers & approvers" hint={policy ? `Policy: at least ${policy.minApprovals} approval${policy.minApprovals === 1 ? "" : "s"}${policy.requireCommentsResolved ? ", all comments resolved" : ""}${policy.allowSelfApproval ? "" : ", authors can’t approve their own work"}.` : undefined}>
            <div className="relative">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people or Entra groups…" />
              {sugg.length > 0 && (
                <ul className="absolute z-20 mt-1 w-full rounded-md border border-border bg-panel p-1 shadow-pop">
                  {sugg.map((s) => (
                    <li key={s.kind + s.id}>
                      <button
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-hover"
                        onClick={() => {
                          setReviewers([...reviewers, s]);
                          setQ("");
                          setSugg([]);
                        }}
                      >
                        {s.kind === "user" ? <Avatar name={s.name} size={18} /> : <Users className="size-4 text-subtle" />}
                        <span>{s.name}</span>
                        {s.kind === "user" && s.email && <span className="text-2xs text-subtle">{s.email}</span>}
                        {s.kind === "group" && <Badge>group</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>
          {reviewers.length > 0 && (
            <ul className="space-y-1">
              {reviewers.map((r, i) => (
                <li key={r.kind + r.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                  {sequential && (
                    <>
                      <GripVertical className="size-3 text-subtle" />
                      <span className="w-4 text-subtle tabular">{i + 1}</span>
                    </>
                  )}
                  {r.kind === "user" ? <User className="size-3.5 text-subtle" /> : <Users className="size-3.5 text-subtle" />}
                  <span className="flex-1">{r.name}</span>
                  {sequential && (
                    <>
                      <button className="text-subtle hover:text-fg" onClick={() => move(i, -1)} aria-label="Move up">
                        ↑
                      </button>
                      <button className="text-subtle hover:text-fg" onClick={() => move(i, 1)} aria-label="Move down">
                        ↓
                      </button>
                    </>
                  )}
                  <button className="text-subtle hover:text-danger" onClick={() => setReviewers(reviewers.filter((x) => x !== r))} aria-label={`Remove ${r.name}`}>
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={sequential} onCheckedChange={setSequential} /> Sequential approval (in the order above)
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due date">
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Attachments">
              <label className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-xs text-muted hover:bg-hover">
                <Paperclip className="size-3" /> {files.length ? `${files.length} file${files.length > 1 ? "s" : ""}` : "Add reference documents"}
                <input type="file" multiple hidden onChange={(e) => setFiles([...(e.target.files ?? [])])} />
              </label>
            </Field>
          </div>
          <Field label="Review instructions">
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="What should reviewers focus on?" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!reviewers.length || busy} onClick={submit}>
            {busy && <Loader2 className="animate-spin" />} Submit & freeze
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CompareDialog({ onClose, arg }: { onClose: () => void; arg?: { versionId?: string } }) {
  const v = useEditor((s) => s.version);
  const ui = useEditorUI();
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [other, setOther] = useState(arg?.versionId ?? "");
  const [mode, setMode] = useState<"overlay" | "side">("overlay");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!v) return;
    api<{ versions: VersionRow[] }>(`/api/projects/${v.projectId}/versions`).then((j) => {
      const list = j.versions.filter((x) => x.id !== v.versionId);
      setVersions(list);
      if (!other && list[0]) setOther(list[0].id);
    });
  }, [v, other]);
  if (!v) return null;
  const go = async () => {
    setBusy(true);
    try {
      const j = await api<{ doc: Doc; label: string }>(`/api/versions/${other}/doc`);
      const cur = useEditor.getState().doc;
      const diff = diffDocs(j.doc, cur);
      useEditor.getState().set("diff", { doc: j.doc, diff, label: j.label, mode });
      ui.toast(`${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"} vs v${j.label}`);
      onClose();
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Compare versions" description={`Compare v${v.label} (current) against another version.`}>
        {!versions ? (
          <Spinner />
        ) : !versions.length ? (
          <p className="text-xs text-subtle">This project has only one version.</p>
        ) : (
          <div className="space-y-3">
            <Field label="Compare with">
              <NativeSelect value={other} onChange={(e) => setOther(e.target.value)}>
                {versions.map((x) => (
                  <option key={x.id} value={x.id}>
                    v{x.label} — {x.status.replace("_", " ").toLowerCase()} {x.summary ? `· ${x.summary.slice(0, 40)}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              {(["overlay", "side"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={cn("rounded-lg border p-3 text-left", mode === m ? "border-accent bg-accent-soft" : "border-border hover:bg-hover")}>
                  <p className="text-xs font-medium">{m === "overlay" ? "Overlay" : "Side by side"}</p>
                  <p className="text-2xs text-muted">{m === "overlay" ? "Changes tinted on one canvas; removed items ghosted in red." : "Two synchronized canvases."}</p>
                </button>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!other || busy} onClick={go}>
            <GitCompare /> Compare
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const KIND_TONE: Record<Change["kind"], "success" | "danger" | "warning" | "accent"> = { added: "success", removed: "danger", changed: "warning", moved: "accent" };

export function DiffDrawer() {
  const diff = useEditor((s) => s.diff);
  const ui = useEditorUI();
  const [filter, setFilter] = useState<Change["kind"] | "all">("all");
  const list = useMemo(() => (diff?.diff.changes ?? []).filter((c) => filter === "all" || c.kind === filter), [diff, filter]);
  if (!diff) return null;
  const go = (c: Change) => {
    const s = useEditor.getState();
    if (c.pageId && c.pageId !== s.pageId && s.doc.pages.some((p) => p.id === c.pageId)) s.setPage(c.pageId);
    requestAnimationFrame(() => {
      if (!c.id) return;
      const page = useEditor.getState().page();
      if (c.area === "element" && page.elements.some((e) => e.id === c.id)) useEditor.getState().setSel({ ...emptySel(), elements: [c.id] });
      else if (c.area === "wire" && page.wires.some((w) => w.id === c.id)) useEditor.getState().setSel({ ...emptySel(), wires: [c.id] });
      else {
        const old = diff.doc.pages.find((p) => p.id === c.pageId)?.elements.find((e) => e.id === c.id);
        if (old) ui.engine.current?.centerOn(old, 2);
        return;
      }
      ui.engine.current?.zoomToSelection();
    });
  };
  return (
    <div className="fixed bottom-12 left-16 z-30 flex max-h-[45vh] w-80 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-pop animate-in">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-xs font-semibold">
          Changes since v{diff.label} <span className="font-normal text-subtle">({diff.diff.changes.length})</span>
        </p>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => useEditor.getState().set("diff", { ...diff, mode: diff.mode === "overlay" ? "side" : "overlay" })}>
            {diff.mode === "overlay" ? "Side by side" : "Overlay"}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Close compare" onClick={() => useEditor.getState().set("diff", null)}>
            <X />
          </Button>
        </div>
      </div>
      <div className="flex gap-1 border-b border-border px-3 py-1.5">
        {(["all", "added", "removed", "changed", "moved"] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)} className={cn("rounded px-1.5 py-0.5 text-2xs capitalize", filter === k ? "bg-hover font-medium" : "text-subtle")}>
            {k} {k !== "all" && diff.diff.summary[k]}
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {list.map((c, i) => (
          <li key={i}>
            <button onClick={() => go(c)} className="w-full border-b border-border px-3 py-1.5 text-left hover:bg-panel-2">
              <div className="flex items-center gap-2">
                <Badge tone={KIND_TONE[c.kind]}>{c.kind}</Badge>
                <span className="truncate text-xs">{c.label}</span>
              </div>
              {c.details?.length ? <p className="mt-0.5 truncate pl-1 text-2xs text-subtle">{c.details.join(" · ")}</p> : null}
            </button>
          </li>
        ))}
        {!list.length && <li className="p-4 text-center text-xs text-subtle">No changes</li>}
      </ul>
    </div>
  );
}

export { ArrowRight, StatusBadge };
