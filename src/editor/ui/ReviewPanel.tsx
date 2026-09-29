"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerDownRight, MapPin, RotateCcw, X, MessageSquare, ThumbsUp, ThumbsDown, AlertCircle, Clock } from "lucide-react";
import { useEditor, type CommentPin } from "../store";
import { useEditorUI } from "./context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Avatar, Badge, Empty, Spinner } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/status";
import { api } from "@/lib/fetcher";
import { cn, relTime, fmtDate } from "@/lib/utils";
import { emptySel } from "@/core/ops";

type C = {
  id: string;
  pageId: string | null;
  anchor: { type: string; id?: string; x: number; y: number } | null;
  parentId: string | null;
  body: string;
  status: string;
  author: { id: string; name: string };
  createdAt: string;
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
  blockers: string[];
};

export function ReviewPanel() {
  const v = useEditor((s) => s.version);
  const active = useEditor((s) => s.activeComment);
  const [list, setList] = useState<C[] | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
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

  const roots = useMemo(() => (list ?? []).filter((c) => !c.parentId && (filter === "all" || c.status === "OPEN" || c.status === "REOPENED")), [list, filter]);

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
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex rounded-md border border-border p-0.5 text-2xs">
          {(["open", "all"] as const).map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={cn("rounded px-2 py-0.5", filter === k ? "bg-hover font-medium" : "text-subtle")}>
              {k === "open" ? "Open" : "All"}
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

function Msg({ c }: { c: C }) {
  return (
    <div className="flex gap-2">
      <Avatar name={c.author.name} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium">{c.author.name}</span>
          <span className="text-2xs text-subtle" title={fmtDate(c.createdAt)}>
            {relTime(c.createdAt)}
          </span>
          {c.anchor && !c.parentId && (
            <Badge tone="purple" className="!h-4">
              {c.anchor.type}
            </Badge>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{highlightMentions(c.body)}</p>
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
