"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerDownRight, MapPin, RotateCcw, X, MessageSquare, ThumbsUp, ThumbsDown, AlertCircle, Clock, Bot, Sparkles, ChevronDown, ChevronRight } from "lucide-react";
import { useEditor, type CommentPin } from "../store";
import { useEditorUI } from "./context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Avatar, Badge, Empty, Spinner } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { api } from "@/lib/fetcher";
import { cn, relTime, fmtDate } from "@/lib/utils";
import { emptySel } from "@/core/ops";
import { ChangeList, locateChange } from "./HistoryPanel";
import type { Change } from "@/core/diff";

type C = {
  id: string;
  pageId: string | null;
  anchor: { type: string; id?: string; x: number; y: number } | null;
  parentId: string | null;
  body: string;
  status: string;
  author: { id: string; name: string; bot?: boolean };
  createdAt: string;
};

type AiStatus = {
  enabled: boolean;
  model: string | null;
  canRun: boolean;
  running: boolean;
  startedAt: string | null;
  last: { at: string; status: "DONE" | "FAILED"; summary: string; findings: number; errors: number; warnings: number; suggestions: number; model: string | null; error: string | null; truncated: boolean } | null;
};

type ReviewInfo = {
  review: {
    id: string;
    status: string;
    dueDate: string | null;
    instructions: string;
    sequential: boolean;
    submittedBy: string;
    assignments: { id: string; order: number; userName: string | null; groupName: string | null; decision: string; reason: string | null; decidedAt: string | null; decidedByName: string | null }[];
  } | null;
  canDecide: boolean;
  canApprove: boolean;
  canRecall?: boolean;
  versionStatus?: string;
  blockers: string[];
};

export function ReviewPanel() {
  const v = useEditor((s) => s.version);
  const active = useEditor((s) => s.activeComment);
  const [list, setList] = useState<C[] | null>(null);
  const [filter, setFilter] = useState<"open" | "ai" | "all">("open");
  const [draft, setDraft] = useState<{ pageId: string; anchor: C["anchor"] } | null>(null);
  const [review, setReview] = useState<ReviewInfo | null>(null);
  const ui = useEditorUI();

  const load = useCallback(async () => {
    if (!v) return;
    try {
      const j = await api<{ comments: C[] }>(`/api/versions/${v.versionId}/comments`);
      setList(j.comments);
      const roots = j.comments.filter((c) => !c.parentId);
      useEditor.getState().set(
        "comments",
        roots.map<CommentPin>((c) => ({ id: c.id, pageId: c.pageId, anchor: c.anchor, status: c.status, body: c.body, author: c.author.name, createdAt: c.createdAt, replies: j.comments.filter((x) => x.parentId === c.id).length })),
      );
    } catch (e) {
      setList([]);
      ui.toast((e as Error).message, { tone: "error" });
    }
    api<ReviewInfo>(`/api/versions/${v.versionId}/review`).then(setReview).catch(() => setReview(null));
  }, [v, ui]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const pending = useEditor((s) => s.pendingComment);
  useEffect(() => {
    if (!pending) return;
    setDraft({ pageId: pending.pageId, anchor: pending.anchor });
    useEditor.getState().set("pendingComment", null);
  }, [pending]);

  const roots = useMemo(
    () => (list ?? []).filter((c) => !c.parentId && (filter === "all" || ((c.status === "OPEN" || c.status === "REOPENED") && (filter === "open" || c.author.bot)))),
    [list, filter],
  );

  const locate = (c: C) => {
    const s = useEditor.getState();
    s.set("activeComment", c.id);
    if (c.pageId && c.pageId !== s.pageId) s.setPage(c.pageId);
    if (c.anchor) {
      requestAnimationFrame(() => {
        ui.engine.current?.centerOn(c.anchor!, Math.max(ui.engine.current.view.s, 1.5));
        if (c.anchor?.type === "element" && c.anchor.id) s.setSel({ ...emptySel(), elements: [c.anchor.id] });
        if (c.anchor?.type === "wire" && c.anchor.id) s.setSel({ ...emptySel(), wires: [c.anchor.id] });
      });
    }
  };

  if (!v) return null;
  return (
    <div className="flex h-full flex-col">
      {review?.review && <ReviewBox info={review} reload={load} />}
      <AiReviewBox versionId={v.versionId} onDone={load} />
      <VersionChanges versionId={v.versionId} />
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex rounded-md border border-border p-0.5 text-2xs">
          {(["open", "ai", "all"] as const).map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={cn("rounded px-2 py-0.5", filter === k ? "bg-hover font-medium" : "text-subtle")}>
              {k === "open" ? "Open" : k === "ai" ? "AI open" : "All"}
            </button>
          ))}
        </div>
        {v.canComment && (
          <Button size="xs" variant="secondary" onClick={() => setDraft({ pageId: useEditor.getState().pageId, anchor: null })}>
            <MessageSquare /> Page comment
          </Button>
        )}
      </div>
      {draft && (
        <Composer
          placeholder={draft.anchor ? "Comment on this spot… use @name to mention" : "Comment on this page… use @name to mention"}
          onCancel={() => setDraft(null)}
          onSubmit={async (body, mentions) => {
            await api(`/api/versions/${v.versionId}/comments`, { method: "POST", json: { body, pageId: draft.pageId, anchor: draft.anchor, mentions } });
            setDraft(null);
            await load();
          }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!list ? (
          <div className="flex justify-center p-6 text-subtle">
            <Spinner />
          </div>
        ) : !roots.length ? (
          <Empty icon={<MessageSquare />} title={filter === "open" ? "No open comments" : "No comments yet"}>
            {v.canComment ? "Press C and click the drawing to comment on a component, wire or area." : "Comments from reviewers appear here."}
          </Empty>
        ) : (
          roots.map((c) => <Thread key={c.id} root={c} replies={(list ?? []).filter((x) => x.parentId === c.id)} active={active === c.id} onLocate={() => locate(c)} reload={load} canComment={v.canComment} versionId={v.versionId} />)
        )}
      </div>
    </div>
  );
}

function ReviewBox({ info, reload }: { info: ReviewInfo; reload: () => void }) {
  const r = info.review!;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ui = useEditorUI();
  const decide = async (decision: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED") => {
    if (decision !== "APPROVED" && !reason.trim()) return ui.toast("Please give a reason", { tone: "error" });
    setBusy(true);
    try {
      await api(`/api/reviews/${r.id}/decision`, { method: "POST", json: { decision, reason } });
      ui.toast(decision === "APPROVED" ? "Approved" : decision === "REJECTED" ? "Rejected" : "Changes requested");
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
      reload();
    }
  };
  return (
    <div className="border-b border-border bg-panel-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold">Review</span>
        <StatusBadge status={r.status} />
      </div>
      {r.instructions && <p className="mb-2 whitespace-pre-wrap text-2xs text-muted">{r.instructions}</p>}
      {r.dueDate && (
        <p className="mb-2 flex items-center gap-1 text-2xs text-muted">
          <Clock className="size-3" /> Due {fmtDate(r.dueDate, false)}
        </p>
      )}
      <ul className="mb-2 space-y-1">
        {r.assignments.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-2xs">
            {r.sequential && <span className="w-3 text-subtle tabular">{a.order + 1}</span>}
            <Avatar name={a.userName ?? a.groupName ?? "?"} size={16} />
            <span className="min-w-0 flex-1 truncate">{a.userName ?? `${a.groupName} (group)`}</span>
            <StatusBadge status={a.decision} />
          </li>
        ))}
      </ul>
      {info.canRecall && <RecallButton approved={info.versionStatus === "APPROVED"} />}
      {info.canDecide && r.status === "OPEN" && (
        <div className="space-y-1.5">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required to reject or request changes)" rows={2} onKeyDown={(e) => e.stopPropagation()} />
          {info.blockers.length > 0 && (
            <p className="flex items-start gap-1 text-2xs text-warning">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              {info.blockers.join(" · ")}
            </p>
          )}
          <div className="flex gap-1">
            <Button size="xs" variant="primary" disabled={busy || !info.canApprove} onClick={() => decide("APPROVED")}>
              <ThumbsUp /> Approve
            </Button>
            <Button size="xs" variant="secondary" disabled={busy} onClick={() => decide("CHANGES_REQUESTED")}>
              Request changes
            </Button>
            <Button size="xs" variant="danger-ghost" disabled={busy} onClick={() => decide("REJECTED")}>
              <ThumbsDown /> Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Thread({ root, replies, active, onLocate, reload, canComment, versionId }: { root: C; replies: C[]; active: boolean; onLocate: () => void; reload: () => void; canComment: boolean; versionId: string }) {
  const [reply, setReply] = useState(false);
  const setStatus = async (status: string) => {
    await api(`/api/comments/${root.id}`, { method: "PATCH", json: { status } });
    reload();
  };
  return (
    <div className={cn("border-b border-border p-3", active && "bg-purple-500/5")}>
      <Msg c={root} />
      <div className="mt-1.5 flex flex-wrap items-center gap-0.5 pl-7">
        {root.anchor && (
          <Button size="xs" variant="ghost" onClick={onLocate}>
            <MapPin /> Locate
          </Button>
        )}
        {canComment && (
          <>
            {root.status === "OPEN" || root.status === "REOPENED" ? (
              <>
                <Button size="xs" variant="ghost" onClick={() => setStatus("RESOLVED")}>
                  <Check /> Resolve
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setStatus("REJECTED")}>
                  <X /> Won’t fix
                </Button>
              </>
            ) : (
              <Button size="xs" variant="ghost" onClick={() => setStatus("REOPENED")}>
                <RotateCcw /> Reopen
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => setReply(!reply)}>
              <CornerDownRight /> Reply
            </Button>
          </>
        )}
        {root.status !== "OPEN" && <StatusBadge status={root.status} className="ml-auto" />}
      </div>
      {replies.length > 0 && (
        <div className="mt-2 space-y-2 border-l-2 border-border pl-3">
          {replies.map((r) => (
            <Msg key={r.id} c={r} />
          ))}
        </div>
      )}
      {reply && (
        <Composer
          compact
          placeholder="Reply…"
          onCancel={() => setReply(false)}
          onSubmit={async (body, mentions) => {
            await api(`/api/versions/${versionId}/comments`, { method: "POST", json: { body, parentId: root.id, pageId: root.pageId, mentions } });
            setReply(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

const SEVERITY: Record<string, string> = {
  Error: "bg-danger-soft text-danger",
  Warning: "bg-warning-soft text-warning",
  Suggestion: "bg-accent-soft text-accent",
  Note: "bg-hover text-muted",
};

/** AI reviewer comments: "Error · Safety\nTitle\n\nDetail\n\nSuggestion: …\n\nReference: …" */
function BotBody({ body }: { body: string }) {
  const [head, ...rest] = body.split("\n");
  const m = /^(Error|Warning|Suggestion|Note) · (.+)$/.exec(head);
  if (!m) return <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{body}</p>;
  const text = rest.join("\n");
  const [title, ...paras] = text.split("\n\n");
  return (
    <div className="space-y-1.5 text-xs leading-relaxed">
      <p className="flex flex-wrap items-center gap-1">
        <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide", SEVERITY[m[1]])}>{m[1]}</span>
        <span className="text-2xs text-muted">{m[2]}</span>
      </p>
      <p className="whitespace-pre-wrap break-words font-medium">{title}</p>
      {paras.map((p, i) =>
        p.startsWith("Suggestion: ") ? (
          <p key={i} className="whitespace-pre-wrap break-words rounded-md border border-success/25 bg-success-soft px-2 py-1 text-success">
            <span className="font-semibold">Suggestion: </span>
            {p.slice(12)}
          </p>
        ) : p.startsWith("Reference: ") ? (
          <p key={i} className="text-2xs text-subtle">
            {p}
          </p>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words text-muted">
            {p}
          </p>
        ),
      )}
    </div>
  );
}

function Msg({ c }: { c: C }) {
  return (
    <div className="flex gap-2">
      {c.author.bot ? (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-300" aria-hidden>
          <Bot className="size-3" />
        </span>
      ) : (
        <Avatar name={c.author.name} size={20} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium">{c.author.name}</span>
          {c.author.bot && (
            <Badge tone="purple" className="!h-4">
              AI
            </Badge>
          )}
          <span className="text-2xs text-subtle" title={fmtDate(c.createdAt)}>
            {relTime(c.createdAt)}
          </span>
          {c.anchor && !c.parentId && (
            <Badge tone="purple" className="!h-4">
              {c.anchor.type}
            </Badge>
          )}
        </div>
        {c.author.bot ? <BotBody body={c.body} /> : <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{highlightMentions(c.body)}</p>}
      </div>
    </div>
  );
}

function highlightMentions(s: string) {
  return s.split(/(@[\w.-]+(?: [\w.-]+)?)/g).map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="rounded bg-accent-soft px-0.5 text-accent">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function Composer({ onSubmit, onCancel, placeholder, compact }: { onSubmit: (body: string, mentions: string[]) => Promise<void>; onCancel: () => void; placeholder: string; compact?: boolean }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [mentions, setMentions] = useState<{ id: string; name: string }[]>([]);
  const [sugg, setSugg] = useState<{ id: string; name: string; email: string }[]>([]);
  const ui = useEditorUI();
  const taRef = useRef<HTMLTextAreaElement>(null);
  // focus after the canvas pointer event that opened the composer has finished (it refocuses the canvas)
  useEffect(() => {
    const t = setTimeout(() => taRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const m = /@([\w.-]*)$/.exec(body);
    if (!m) return setSugg([]);
    const t = setTimeout(() => {
      api<{ users: { id: string; name: string; email: string }[] }>(`/api/users?q=${encodeURIComponent(m[1])}`)
        .then((j) => setSugg(j.users.slice(0, 6)))
        .catch(() => setSugg([]));
    }, 150);
    return () => clearTimeout(t);
  }, [body]);
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await onSubmit(body.trim(), mentions.filter((m) => body.includes("@" + m.name)).map((m) => m.id));
      setBody("");
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("relative space-y-1.5", compact ? "mt-2 pl-7" : "border-b border-border bg-panel-2 p-3")}>
      <Textarea
        ref={taRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {sugg.length > 0 && (
        <ul className="absolute z-20 w-56 rounded-md border border-border bg-panel p-1 shadow-pop">
          {sugg.map((u) => (
            <li key={u.id}>
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-hover"
                onClick={() => {
                  setBody((b) => b.replace(/@([\w.-]*)$/, "@" + u.name + " "));
                  setMentions((m) => [...m, { id: u.id, name: u.name }]);
                  setSugg([]);
                }}
              >
                <Avatar name={u.name} size={16} />
                <span className="truncate">{u.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" disabled={busy || !body.trim()} onClick={submit}>
          {busy ? <Spinner /> : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function AiReviewBox({ versionId, onDone }: { versionId: string; onDone: () => void }) {
  const [st, setSt] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ui = useEditorUI();
  const wasRunning = useRef(false);
  const load = useCallback(async () => {
    try {
      const j = await api<AiStatus>(`/api/versions/${versionId}/ai-review`);
      setSt(j);
      if (wasRunning.current && !j.running) onDone();
      wasRunning.current = j.running;
    } catch {
      setSt(null);
    }
  }, [versionId, onDone]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!st?.running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [st?.running, load]);
  if (!st || !st.enabled || (!st.last && !st.running && !st.canRun)) return null;
  const run = async () => {
    setBusy(true);
    try {
      await ui.saveNow();
      await api(`/api/versions/${versionId}/ai-review`, { method: "POST" });
      wasRunning.current = true;
      setSt((x) => (x ? { ...x, running: true } : x));
      ui.toast("AI review started — findings arrive as comments");
    } catch (e) {
      ui.toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const l = st.last;
  return (
    <div className="border-b border-border bg-purple-500/[0.04] p-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-purple-600 dark:text-purple-300" />
        <span className="text-xs font-semibold">AI reviewer</span>
        {st.running ? (
          <span className="flex items-center gap-1 text-2xs text-muted">
            <Spinner /> checking…
          </span>
        ) : l ? (
          <span className="truncate text-2xs text-muted" title={fmtDate(l.at)}>
            {l.status === "FAILED" ? "failed" : `${l.findings} finding${l.findings === 1 ? "" : "s"}`} · {relTime(l.at)}
          </span>
        ) : null}
        {st.canRun && (
          <Button size="xs" variant="secondary" className="ml-auto" disabled={busy || st.running} onClick={run} title={st.model ? `Rule checks + ${st.model}` : "Rule checks (AI model not configured)"}>
            {l ? "Run again" : "Run AI review"}
          </Button>
        )}
      </div>
      {l && !st.running && (
        <>
          {l.status === "DONE" && l.findings > 0 && (
            <div className="mt-1.5 flex gap-1.5 text-[10px] font-semibold">
              {l.errors > 0 && <span className="rounded bg-danger-soft px-1.5 py-px text-danger">{l.errors} error{l.errors === 1 ? "" : "s"}</span>}
              {l.warnings > 0 && <span className="rounded bg-warning-soft px-1.5 py-px text-warning">{l.warnings} warning{l.warnings === 1 ? "" : "s"}</span>}
              {l.suggestions > 0 && <span className="rounded bg-accent-soft px-1.5 py-px text-accent">{l.suggestions} suggestion{l.suggestions === 1 ? "" : "s"}</span>}
            </div>
          )}
          {(l.summary || l.error) && (
            <button className="mt-1.5 flex w-full items-start gap-1 text-left text-2xs text-muted hover:text-fg" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
              {open ? <ChevronDown className="mt-0.5 size-3 shrink-0" /> : <ChevronRight className="mt-0.5 size-3 shrink-0" />}
              <span className={cn("whitespace-pre-wrap", !open && "line-clamp-2")}>{l.error ?? l.summary}</span>
            </button>
          )}
          {open && (
            <p className="mt-1 pl-4 text-[10px] text-subtle">
              {l.model ? `Rule checks + ${l.model}` : "Rule checks only"}
              {l.truncated ? " · project too large, the AI saw only part of it" : ""} · the designer resolves each finding (Resolve / Won’t fix with a reply).
            </p>
          )}
        </>
      )}
    </div>
  );
}

function RecallButton({ approved }: { approved: boolean }) {
  const v = useEditor((s) => s.version);
  const ui = useEditorUI();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!v) return null;
  if (!open)
    return (
      <Button size="xs" variant="ghost" className="mb-2" onClick={() => setOpen(true)} title="The version returns to draft so it can be edited; the review is closed as recalled">
        <RotateCcw /> {approved ? "Take back approval" : "Recall to draft to fix"}
      </Button>
    );
  return (
    <div className="mb-2 space-y-1.5 rounded-md border border-border bg-panel p-2">
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (e.g. fixing the AI review findings)" rows={2} onKeyDown={(e) => e.stopPropagation()} />
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/versions/${v.versionId}/recall`, { method: "POST", json: { reason } });
              ui.toast(`v${v.label} is a draft again`);
              setTimeout(() => location.reload(), 500);
            } catch (e) {
              ui.toast((e as Error).message, { tone: "error" });
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : approved ? "Take back approval" : "Recall to draft"}
        </Button>
      </div>
    </div>
  );
}

/** what this version changes against where it started — the "files changed" of a pull request */
function VersionChanges({ versionId }: { versionId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ base: string; total: number; summary: Record<string, number>; changes: Change[]; initial: boolean } | null>(null);
  const ui = useEditorUI();
  useEffect(() => {
    if (!open || data) return;
    api<NonNullable<typeof data>>(`/api/versions/${versionId}/changes`)
      .then(setData)
      .catch(() => setData({ base: "", total: 0, summary: {}, changes: [], initial: true }));
  }, [open, data, versionId]);
  return (
    <div className="border-b border-border px-3 py-2">
      <button className="flex w-full items-center gap-1 text-left text-xs font-semibold" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Changes in this version
        {data && !data.initial && <span className="ml-auto text-2xs font-normal text-subtle">{data.total} vs {data.base}</span>}
      </button>
      {open && (!data ? <Spinner /> : data.initial ? <p className="mt-1 text-2xs text-subtle">First version — everything is new.</p> : <ChangeList changes={data.changes} onPick={(c) => locateChange(c, ui)} />)}
    </div>
  );
}
